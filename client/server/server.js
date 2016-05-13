'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var fs = require('fs');
var child_process = require('child_process');
var vscode_languageserver_1 = require('vscode-languageserver');
var LogEntry_1 = require('./LogEntry');
// Create a connection for the server. The connection uses Node's IPC as a transport
var connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
// Create a simple text document manager. The text document manager
// supports full document sync only
var documents = new vscode_languageserver_1.TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
var workspaceRoot;
connection.onInitialize(function (params) {
    connection.console.log("S: connected");
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true
            }
        }
    };
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(function (change) {
    connection.console.log('S: content changed');
    //verifyTextDocument(change.document.uri);
});
// hold the maxNumberOfProblems setting
var verificationBackend;
var useSilicon;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(function (change) {
    connection.console.log('S: configuration changed');
    var settings = change.settings;
    verificationBackend = settings.iveServerSettings.verificationBackend || "silicon";
    if (verificationBackend != "silicon" && verificationBackend != "carbon") {
        connection.sendNotification({ method: "InvalidSettings" }, "Only carbon and silicon are valid verification backends.");
    }
    useSilicon = verificationBackend == "silicon";
    // // Revalidate any open text documents
    // documents.all().forEach(document => {
    //     verifyTextDocument(document.uri);
    // });
});
var verificationRunning = false;
var wrongFormat = false;
var diagnostics;
var verifierProcess;
var nailgunProcess;
connection.onNotification({ method: 'startNailgun' }, function () {
    startNailgunServer();
});
connection.onNotification({ method: 'stopNailgun' }, function () {
    stopNailgunServer();
});
function startNailgunServer() {
    if (!nailgunProcess) {
        connection.console.info('S: starting nailgun server');
        var nailgunServerExe = process.env.NAILGUN_SERVER_EXE;
        if (!nailgunServerExe) {
            connection.console.error('S: NAILGUN_SERVER_EXE environment variable is not set');
            return;
        }
        verifierProcess = child_process.exec('java -jar "' + nailgunServerExe + '"');
        verifierProcess.stdout.on('data', function (data) {
            connection.console.log('NS:' + data);
        });
    }
    else {
        connection.console.info('S: nailgun server already running');
    }
}
function stopNailgunServer() {
    if (nailgunProcess) {
        connection.console.info('S: shutting down nailgun server');
        nailgunProcess.kill('SIGINT');
    }
}
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function verifyTextDocument(uri) {
    verificationRunning = true;
    //Initialization
    diagnostics = [];
    //reset diagnostics
    connection.sendDiagnostics({ uri: uri, diagnostics: diagnostics });
    wrongFormat = false;
    connection.console.info('S: ' + verificationBackend + ' verification startet');
    connection.sendNotification({ method: "VerificationStart" });
    var path = uriToPath(uri); //textDocument.uri;
    //connection.console.log("path is: "+path);
    //start verification of current file
    var currfile = '"' + path + '"';
    //let siliconHome = 'C:\\Users\\ruben\\Desktop\\Masterthesis\\Viper\\silicon';
    var env = process.env;
    var siliconHome = process.env.SILICON_HOME;
    var carbonHome = process.env.CARBON_HOME;
    if (!siliconHome) {
        connection.console.warn('S: SILICON_HOME Environment Variable is not set.');
    }
    if (!carbonHome) {
        connection.console.warn('S: CARBON_HOME Environment Variable is not set.');
    }
    var home = carbonHome;
    if (useSilicon) {
        home = siliconHome;
    }
    if (!home) {
        connection.console.error('S: Cannot start verification because the Environment variable to ' + verificationBackend + 'is not set');
        verificationRunning = false;
        connection.sendNotification({ method: "VerificationEnd" }, false);
        return;
    }
    //connection.console.log('SERVER:  Env: SILICON_HOME: ' + siliconHome);
    //connection.console.log('SERVER: Silicon: verify ' + currfile);
    verifierProcess = child_process.exec(verificationBackend + '.bat --ideMode ' + currfile, { cwd: home });
    var time = "0";
    verifierProcess.stdout.on('data', function (data) {
        //connection.console.log('SERVER: stdout: ' + data);
        if (wrongFormat) {
            return;
        }
        var stringData = data;
        var parts = stringData.split(/\r?\n/g);
        parts.forEach(function (part, i, array) {
            if (part.startsWith("Command-line interface:")) {
                connection.console.error('S: Could not start verification -> fix format');
                wrongFormat = true;
            }
            if (part.startsWith('Silicon finished in') || part.startsWith('carbon finished in')) {
                time = /.*?(\d*\.\d*).*/.exec(part)[1];
            }
            else if (part == 'No errors found.') {
                connection.console.info('S: Successfully verified with ' + verificationBackend + ' in ' + time + ' seconds.');
                time = "0";
            }
            else if (part.startsWith('The following errors were found')) {
                connection.console.info('S: ' + verificationBackend + ': Verification failed after ' + time + ' seconds.');
                time = "0";
            }
            else if (part.startsWith('  ')) {
                var pos = /\s*(\d*):(\d*):\s(.*)/.exec(part);
                if (pos.length != 4) {
                    connection.console.error('S: could not parse error description: "' + part + '"');
                    return;
                }
                var lineNr = +pos[1] - 1;
                var charNr = +pos[2] - 1;
                var message = pos[3].trim();
                diagnostics.push({
                    severity: vscode_languageserver_1.DiagnosticSeverity.Error,
                    range: {
                        start: { line: lineNr, character: charNr },
                        end: { line: lineNr, character: Number.MAX_SAFE_INTEGER }
                    },
                    message: message,
                    source: verificationBackend
                });
            }
        });
    });
    verifierProcess.stderr.on('data', function (data) {
        connection.console.log("stderr: " + data);
    });
    verifierProcess.on('close', function (code) {
        connection.console.info("S: Child process exited with code " + code);
        // Send the computed diagnostics to VSCode.
        connection.sendDiagnostics({ uri: uri, diagnostics: diagnostics });
        connection.sendNotification({ method: "VerificationEnd" }, diagnostics.length == 0);
        verificationRunning = false;
        var logFile = readZ3LogFile(siliconHome + '\\tmp\\logfile.smt2');
    });
}
function abortVerification() {
    connection.console.error('S: abort running verification');
    if (!verificationRunning) {
        connection.console.error('S: cannot abort, verification is not running.');
        return;
    }
    //remove impact of child_process to kill
    verifierProcess.removeAllListeners('close');
    verifierProcess.stdout.removeAllListeners('data');
    verifierProcess.stderr.removeAllListeners('data');
    //log the exit of the child_process to kill
    verifierProcess.on('exit', function (code, signal) {
        connection.console.info("S: Child process exited with code " + code + " and signal " + signal);
    });
    verifierProcess.kill('SIGINT');
    var l = verifierProcess.listeners;
    verificationRunning = false;
}
connection.onDidChangeWatchedFiles(function (change) {
    // Monitored files have change in VSCode
    connection.console.log('S: We recevied an file change event');
});
// // This handler provides the initial list of the completion items.
// connection.onCompletion((textPositionParams): CompletionItem[] => {
//     // The pass parameter contains the position of the text document in 
//     // which code complete got requested. For the example we ignore this
//     // info and always provide the same completion items.
//     var res = [];
//     let completionItem: CompletionItem = {
//         label: 'invariant',
//         kind: CompletionItemKind.Text,
//         data: 1
//     };
//     res.push(completionItem);
//     return res;
// });
// // This handler resolve additional information for the item selected in
// // the completion list.
// connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
//     //connection.console.log('onCompletionResolve');
//     if (item.data === 1) {
//         item.detail = 'add an invariant',
//             item.documentation = 'The invariant needs to hold before and after the loop body'
//     }
//     return item;
// });
connection.onDidOpenTextDocument(function (params) {
    // A text document got opened in VSCode.
    // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
    // params.text the initial full content of the document.
    var doc = params.textDocument;
    connection.console.log("S: " + params.textDocument.uri + " opened.");
});
connection.onDidChangeTextDocument(function (params) {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    //connection.console.log(`${params.uri} changed: ${JSON.stringify(params.contentChanges)}`);
    //let doc = params.textDocument;
    //verifyTextDocument(params.textDocument.uri);
});
connection.onDidCloseTextDocument(function (params) {
    // A text document got closed in VSCode.
    // params.uri uniquely identifies the document.
    connection.console.log("S: " + params.textDocument.uri + " closed.");
});
connection.onDidSaveTextDocument(function (params) {
    var doc = params.textDocument;
    if (verificationRunning) {
        connection.console.log("S: verification already running -> abort and restart.");
        abortVerification();
    }
    verifyTextDocument(params.textDocument.uri);
});
// Listen on the connection
connection.listen();
function readZ3LogFile(path) {
    var res = new Array();
    if (!fs.existsSync(path)) {
        connection.console.error("cannot find log file at: " + path);
        return;
    }
    var content = fs.readFileSync(path, "utf8").split(/\n(?!\s)/g);
    for (var i = 0; i < content.length; i++) {
        var line = content[i].replace("\n", "").trim();
        if (line == '') {
            continue;
        }
        var prefix = ';';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.Comment, line.substring(prefix.length)));
            continue;
        }
        prefix = '(push)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.Push, line.substring(prefix.length)));
            continue;
        }
        prefix = '(pop)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.Pop, line.substring(prefix.length)));
            continue;
        }
        prefix = '(set-option';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.SetOption, line));
            continue;
        }
        prefix = '(declare-const';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DeclareConst, line));
            continue;
        }
        prefix = '(declare-fun';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DeclareFun, line));
            continue;
        }
        prefix = '(declare-datatypes';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DeclareDatatypes, line));
            continue;
        }
        prefix = '(declare-sort';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DeclareSort, line));
            continue;
        }
        prefix = '(define-const';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DefineConst, line));
            continue;
        }
        prefix = '(define-fun';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DefineFun, line));
            continue;
        }
        prefix = '(define-datatypes';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DefineDatatypes, line));
            continue;
        }
        prefix = '(define-sort';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.DefineSort, line));
            continue;
        }
        prefix = '(assert';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.Assert, line));
            continue;
        }
        prefix = '(check-sat)';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.CheckSat, line.substring(prefix.length)));
            continue;
        }
        prefix = '(get-info';
        if (line.startsWith(prefix)) {
            res.push(new LogEntry_1.LogEntry(LogEntry_1.LogType.GetInfo, line));
            continue;
        }
        connection.console.error("S: unknown log-entry-type detected: " + line);
    }
    return res;
}
function uriToPath(uri) {
    if (!uri.startsWith("file:")) {
        connection.console.error("S: cannot convert uri to filepath, uri: " + uri);
    }
    uri = uri.replace("\%3A", ":");
    uri = uri.replace("file:\/\/\/", "");
    uri = uri.replace("\%20", " ");
    return uri;
}
//# sourceMappingURL=server.js.map