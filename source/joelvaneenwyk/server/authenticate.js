/*jslint node: true */
"use strict";

var request = require("request");
var google = require('googleapis');
var OAuth2 = google.auth.OAuth2;
var pg = require('pg');
var fs = require('fs');
var path = require('path');
var root = path.normalize(__dirname);

var session = require('express-session');
var pgSession = require('connect-pg-simple')(session);

// Initialize our oauth variables used to store access_token and related data
var oauth_states = [];

// Variables for postgres
var client = new pg.Client();
var databaseConnected = false;

function setupApp(app, databaseURL, next) {
    app.use(session({
        store: new pgSession({
            pg: pg,
            conString: databaseURL,
            tableName: 'session'
        }),
        saveUninitialized: true,
        secret: process.env.COOKIE_SECRET,
        resave: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
    }));

    app.get("/db/status", function(req, res) {
        res.send(databaseConnected);
    });

    // Start the OAuth flow by generating a URL that the client (index.html) opens
    // as a popup. The URL takes the user to Google's site for authentication
    app.get("/api/login", function(req, res) {
        var oauth2Client = new OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            getCallbackUrl(req));

        var sess = req.session;
        try {
            sess.views++;
        } catch (e) {
            sess.views = 1;
        }

        // Generate a unique number that will be used to check if any hijacking
        // was performed during the OAuth flow
        var state = -1;
        do {
            state = Math.floor(Math.random() * 1e18).toString();
        }
        while (oauth_states.indexOf(state) != -1);
        oauth_states.push(state);

        var url = oauth2Client.generateAuthUrl({
            // 'online' (default) or 'offline' (gets refresh_token)
            access_type: 'offline',
            // If you only need one scope you can pass it as string
            scope: [
                "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email"
            ],
            state: state,
            display: "popup",
            response_type: "code"
        });

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(url);
    });

    // The route that Google will redirect the popup to once the user has authed.
    // The data passed back will be used to retrieve the access_token
    app.get("/oauth2callback", function(req, res) {

        // Collect the data contained in the querystring
        var code = req.query.code;
        var cb_state = req.query.state;
        var error = req.query.error;

        // Verify the 'state' variable generated during '/login' equals what was passed back
        if (oauth_states.indexOf(cb_state) != -1) {
            // Remove this state from the list since we've used it
            oauth_states.splice(oauth_states.indexOf(cb_state), 1);
            if (code !== undefined) {

                // Setup params and URL used to call API to obtain an access_token
                var params = {
                    code: code,
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: getCallbackUrl(req),
                    grant_type: "authorization_code"
                };
                var token_url = "https://accounts.google.com/o/oauth2/token";

                // Send the API request
                request.post(token_url, { form: params }, function(err, resp, body) {

                    // Handle any errors that may occur
                    if (err) return console.error("Error occured: ", err);
                    var results = JSON.parse(body);
                    if (results.error) return console.error("Error returned from Google: ", results.error);

                    var user = {
                        'access_token': results.access_token,
                        'token_type': results.token_type,
                        'expires': results.expires_in
                    };

                    console.log("Connected to Google");

                    // Close the popup and call the parent onLogin function
                    var output =
                        '<html>\n' +
                        '<head>\n' +
                        '<script type="text/javascript" src="/js/login.js"></script>\n' +
                        '<script>\n' +
                        'function onLoad() {\n' +
                        'var user=' + JSON.stringify(user) + ';\n' +
                        'onLoginSuccess(user);\n' +
                        '}\n' +
                        '</script>\n' +
                        '</head>\n' +
                        '<body onload="onLoad();"></body>\n' +
                        '</html>';
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(output);
                });
            } else {
                console.log("Code is undefined: " + code);
                console.log("Error: " + error);
            }
        } else {
            console.log('Mismatch with variable state');
        }
    });

    // Test out the access_token by making an API call
    app.get("/user", function(req, res) {

        var user;

        try {
            user = JSON.parse(req.cookies.user);
        } catch (e) {
            console.log("Failed to get user from request");
        }

        // Check to see if user as an access_token first
        if (user.access_token) {

            // URL endpoint and params needed to make the API call
            var info_url = "https://www.googleapis.com/oauth2/v1/userinfo";
            var params = {
                access_token: user.access_token
            };

            // Send the request
            request.get({ url: info_url, qs: params }, function(err, resp, user) {
                // Check for errors
                if (err) return console.error("Error occured: ", err);

                // Send output as response
                var output = "<h1>Your User Details</h1><pre>" + user + "</pre>";
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(output);
            });
        } else {
            console.log("Couldn't verify user was authenticated. Redirecting to /");
            res.redirect("/");
        }
    });

    app.all('/p/*', function(req, res, next) {
        if (!req.session.loggedIn) {
            res.redirect("/login");
        } else if (req.session.loggedIn) {
            next();
        }
    });

    next();
}

function setupDatabase(app, newClient, databaseURL, next) {
    console.log('Connected to postgres!');

    databaseConnected = true;

    client = newClient;

    var sqlUsers = fs.readFileSync(root + '/postgres/create_users.sql').toString();
    client
        .query(sqlUsers)
        .on('end', function() { client.end(); });

    var sqlSessions = fs.readFileSync(root + '/postgres/create_session.sql').toString();
    client.query(sqlSessions, function(err, result) {
        if (err) {
            console.log('Session table already exists');
        } else {
            console.log('Successfully created session table');
        }
        setupApp(app, databaseURL, next);
    });
}

function getCallbackUrl(req) {
    // Define API credentials callback URL
    var url = req.protocol + '://' + req.get('host');
    var callbackURL = url + "/oauth2callback";
    console.log('Callback URL:' + callbackURL);
    return callbackURL;
}

function setup(app, next) {
    pg.defaults.ssl = true;
    pg.connect(process.env.PG_REMOTE_URL, function(remoteErr, remoteClient) {
        if (remoteErr) {
            console.log('Failed to connect to remote postgres. Connecting to local postgres...');
            pg.defaults.ssl = false;
            pg.connect(process.env.PG_LOCAL_URL, function(localErr, localClient) {
                if (localErr) {
                    console.log('Failed to connect to local postgres');
                    console.log(localErr);
                } else {
                    setupDatabase(app, localClient, process.env.PG_LOCAL_URL, next);
                }
            });
        } else {
            setupDatabase(app, remoteClient, process.env.PG_REMOTE_URL, next);
        }
    });
}

module.exports = {
    setup: setup
};
