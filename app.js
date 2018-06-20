var path = require('path');
var LatexOnline = require('./lib/LatexOnline');
var Janitor = require('./lib/Janitor');
var HealthMonitor = require('./lib/HealthMonitor');
var utils = require('./lib/utilities');

var logger = utils.logger('app.js');

var VERSION = process.env.VERSION || "master";
VERSION = VERSION.substr(0, 9);

// Will be initialized later.
var latexOnline;
var healthMonitor;

// Initialize service dependencies.
LatexOnline.create('/tmp/downloads/', '/tmp/storage/')
    .then(onInitialized)

function onInitialized(latex) {
    latexOnline = latex;
    if (!latexOnline) {
        logger.error('ERROR: failed to initialize latexOnline');
        return;
    }

    // Initialize janitor to clean up stale storage.
    var expiry = utils.hours(24);
    var cleanupTimeout = utils.minutes(5);
    var janitor = new Janitor(latexOnline, expiry, cleanupTimeout);

    // Initialize health monitor
    healthMonitor = new HealthMonitor(latexOnline);

    // Launch server.
    var port = process.env.PORT || 2700;
    var listener = app.listen(port, () => {
        logger.info("Express server started (3)", {
            port: listener.address().port,
            env: app.settings.env,
            sha: VERSION
        });
    });
}

// Initialize server.
var express = require('express');
var compression = require('compression');
var useragent = require('express-useragent');
var bodyParser = require('body-parser');

var app = express();

app.use(compression());
app.use(useragent.express());
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function sendError(res, userError) {
    res.set('Content-Type', 'text/plain');
    var statusCode = userError ? 400 : 500;
    var error = userError || 'Internal Server Error';
    res.status(statusCode).send(error)
}

async function handleResult(res, preparation, force, downloadName) {
    var {request, downloader, userError} = preparation;
    if (!request) {
        sendError(res, userError);
        return;
    }
    var compilation = latexOnline.compilationWithFingerprint(request.fingerprint);
    if (force && compilation) {
      latexOnline.removeCompilation(compilation);
    }

    compilation = latexOnline.getOrCreateCompilation(request, downloader);
    await compilation.run();

    // In case of URL compilation and cached compilation object, the downlaoder
    // has to be cleaned up.
    downloader.dispose();
    if (compilation.userError) {
        sendError(res, compilation.userError);
    } else if (compilation.success) {
        if (downloadName) {
            res.set('content-disposition', `attachment; filename="${downloadName}"`);
        }
        res.status(200).sendFile(compilation.outputPath(), {acceptRanges: false});
    } else {
        res.status(400).sendFile(compilation.logPath(), {acceptRanges: false});
    }
}

app.post('/compile', async (req, res) => {
    var forceCompilation = req.query && !!req.query.force;
    var command = req.query && req.query.command ? req.query.command : 'pdflatex';
    command = command.trim().toLowerCase();
    var preparation;

    logger.info('req.body', req.body);
    if (req.body.text) {
        preparation = await latexOnline.prepareTextCompilation(req.body.text, command);
    }

    if (preparation)
        handleResult(res, preparation, forceCompilation, req.query.download);
    else
        sendError(res, 'ERROR: failed to parse request: ' + JSON.stringify(req.query));
});
