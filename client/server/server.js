'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode_languageserver_1 = require('vscode-languageserver');
const Log_1 = require('./Log');
const Settings_1 = require('./Settings');
const ViperProtocol_1 = require('./ViperProtocol');
const NailgunService_1 = require('./NailgunService');
const VerificationTask_1 = require('./VerificationTask');
const DebugServer_1 = require('./DebugServer');
const ServerClass_1 = require('./ServerClass');
// Create a connection for the server. The connection uses Node's IPC as a transport
ServerClass_1.Server.connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
ServerClass_1.Server.documents.listen(ServerClass_1.Server.connection);
registerHandlers();
// Listen on the connection
ServerClass_1.Server.connection.listen();
function registerHandlers() {
    //starting point (executed once)
    ServerClass_1.Server.connection.onInitialize((params) => {
        try {
            DebugServer_1.DebugServer.initialize();
            //Server.workspaceRoot = params.rootPath;
            ServerClass_1.Server.nailgunService = new NailgunService_1.NailgunService();
            return {
                capabilities: {}
            };
        }
        catch (e) {
            Log_1.Log.error("Error handling initialize request: " + e);
        }
    });
    ServerClass_1.Server.connection.onShutdown(() => {
        try {
            Log_1.Log.log("On Shutdown", ViperProtocol_1.LogLevel.Debug);
            ServerClass_1.Server.nailgunService.stopNailgunServer();
        }
        catch (e) {
            Log_1.Log.error("Error handling shutdown: " + e);
        }
    });
    ServerClass_1.Server.connection.onDidChangeConfiguration((change) => {
        try {
            let oldSettings = Settings_1.Settings.settings;
            Settings_1.Settings.settings = change.settings.viperSettings;
            Log_1.Log.logLevel = Settings_1.Settings.settings.preferences.logLevel; //after this line, Logging works
            Log_1.Log.log('Configuration changed', ViperProtocol_1.LogLevel.Info);
            Settings_1.Settings.checkSettings().then(() => {
                if (Settings_1.Settings.valid()) {
                    restartBackendIfNeeded(oldSettings);
                }
                else {
                    ServerClass_1.Server.nailgunService.stopNailgunServer();
                }
            });
        }
        catch (e) {
            Log_1.Log.error("Error handling configuration change: " + e);
        }
    });
    ServerClass_1.Server.connection.onNotification(ViperProtocol_1.Commands.StartBackend, (selectedBackend) => {
        try {
            if (!selectedBackend || selectedBackend.length == 0) {
                Log_1.Log.log("No backend was chosen, don't restart backend", ViperProtocol_1.LogLevel.Debug);
            }
            else {
                //recheck settings upon backend change
                Settings_1.Settings.checkSettings().then(() => {
                    if (Settings_1.Settings.valid()) {
                        Settings_1.Settings.selectedBackend = selectedBackend;
                        restartBackendIfNeeded(null);
                    }
                    else {
                        ServerClass_1.Server.nailgunService.stopNailgunServer();
                    }
                });
            }
        }
        catch (e) {
            Log_1.Log.error("Error handling select backend request: " + e);
        }
    });
    //returns the a list of all backend names
    ServerClass_1.Server.connection.onRequest(ViperProtocol_1.Commands.RequestBackendNames, () => {
        return new Promise((resolve, reject) => {
            try {
                let backendNames = Settings_1.Settings.getBackendNames(Settings_1.Settings.settings);
                if (!backendNames) {
                    reject("No backend found");
                }
                else {
                    resolve(backendNames);
                }
            }
            catch (e) {
                reject("Error handling backend names request: " + e);
            }
        });
    });
    ServerClass_1.Server.connection.onDidOpenTextDocument((params) => {
        try {
            if (ServerClass_1.Server.isViperSourceFile(params.textDocument.uri)) {
                let uri = params.textDocument.uri;
                //notify client;
                ServerClass_1.Server.sendFileOpenedNotification(params.textDocument.uri);
                if (!ServerClass_1.Server.verificationTasks.has(uri)) {
                    //create new task for opened file
                    let task = new VerificationTask_1.VerificationTask(uri, ServerClass_1.Server.nailgunService);
                    ServerClass_1.Server.verificationTasks.set(uri, task);
                }
            }
        }
        catch (e) {
            Log_1.Log.error("Error handling TextDocument openend");
        }
    });
    ServerClass_1.Server.connection.onDidCloseTextDocument((params) => {
        try {
            if (ServerClass_1.Server.isViperSourceFile(params.textDocument.uri)) {
                let uri = params.textDocument.uri;
                //notify client;
                ServerClass_1.Server.sendFileClosedNotification(uri);
                if (ServerClass_1.Server.verificationTasks.has(uri)) {
                    //remove no longer needed task
                    ServerClass_1.Server.verificationTasks.delete(uri);
                }
            }
        }
        catch (e) {
            Log_1.Log.error("Error handling TextDocument closed");
        }
    });
    function canVerificationBeStarted(uri, manuallyTriggered) {
        //check if there is already a verification task for that file
        let task = ServerClass_1.Server.verificationTasks.get(uri);
        if (!task) {
            Log_1.Log.error("No verification task found for file: " + uri);
            return false;
        }
        else if (task.running) {
            return false;
        }
        else if (!ServerClass_1.Server.isViperSourceFile(uri)) {
            //only verify viper source code files
            Log_1.Log.hint("Only viper source files can be verified.");
            Log_1.Log.error("Only viper source files can be verified.");
            return false;
        }
        else if (!ServerClass_1.Server.nailgunService.isReady()) {
            if (manuallyTriggered)
                Log_1.Log.hint("The verification backend is not ready yet");
            Log_1.Log.error("The verification backend is not ready yet");
            return false;
        }
        return true;
    }
    ServerClass_1.Server.connection.onNotification(ViperProtocol_1.Commands.Verify, (data) => {
        try {
            let verificationstarted = false;
            //it does not make sense to reverify if no changes were made and the verification is already running
            if (canVerificationBeStarted(data.uri, data.manuallyTriggered)) {
                Settings_1.Settings.workspace = data.workspace;
                Log_1.Log.log("start or restart verification", ViperProtocol_1.LogLevel.Info);
                //stop all other verifications because the backend crashes if multiple verifications are run in parallel
                VerificationTask_1.VerificationTask.stopAllRunningVerifications().then(success => {
                    //start verification
                    ServerClass_1.Server.executedStages = [];
                    verificationstarted = ServerClass_1.Server.verificationTasks.get(data.uri).verify(data.manuallyTriggered) === true;
                    if (!verificationstarted) {
                        ServerClass_1.Server.sendVerificationNotStartedNotification(data.uri);
                    }
                }, () => {
                    ServerClass_1.Server.sendVerificationNotStartedNotification(data.uri);
                });
            }
        }
        catch (e) {
            Log_1.Log.error("Error handling verify request: " + e);
            ServerClass_1.Server.sendVerificationNotStartedNotification(data.uri);
        }
    });
    ServerClass_1.Server.connection.onRequest(ViperProtocol_1.Commands.Dispose, () => {
        try {
            //Server.nailgunService.stopNailgunServer();
            ServerClass_1.Server.nailgunService.killNailgunServer();
            ServerClass_1.Server.nailgunService.killNgAndZ3DeamonWin();
        }
        catch (e) {
            Log_1.Log.error("Error handling dispose request: " + e);
        }
    });
    ServerClass_1.Server.connection.onRequest(ViperProtocol_1.Commands.GetExecutionTrace, (params) => {
        Log_1.Log.log("Generate execution trace for client state " + params.clientState, ViperProtocol_1.LogLevel.Debug);
        return new Promise((resolve, reject) => {
            let result = [];
            try {
                let task = ServerClass_1.Server.verificationTasks.get(params.uri);
                let serverState = task.clientStepIndexToServerStep[params.clientState];
                let maxDepth = serverState.depthLevel();
                let dark = Settings_1.Settings.settings.advancedFeatures.darkGraphs === true;
                if (!Settings_1.Settings.settings.advancedFeatures.simpleMode) {
                    //ADVANCED MODE ONLY
                    //get stateExpansion states
                    serverState.verifiable.forAllExpansionStatesWithDecoration(serverState, (child) => {
                        result.push({
                            state: child.decorationOptions.index,
                            color: ViperProtocol_1.StateColors.uninterestingState(dark),
                            showNumber: true
                        });
                    });
                    //get top level statements
                    serverState.verifiable.getTopLevelStatesWithDecoration().forEach(child => {
                        result.push({
                            state: child.decorationOptions.index,
                            color: ViperProtocol_1.StateColors.uninterestingState(dark),
                            showNumber: true
                        });
                    });
                }
                //BOTH SIMPLE AND ANVANCED MODE
                //get executionTrace of serverState
                while (true) {
                    let depth = serverState.depthLevel();
                    if (serverState.canBeShownAsDecoration && depth <= maxDepth) {
                        maxDepth = depth;
                        result.push({
                            state: serverState.decorationOptions.index,
                            color: ViperProtocol_1.StateColors.interestingState(dark),
                            showNumber: true
                        }); //push client state
                    }
                    if (serverState.isBranch()) {
                        serverState = serverState.parent;
                    }
                    else if (!serverState.parent) {
                        break;
                    }
                    else {
                        serverState = task.steps[serverState.index - 1];
                    }
                    task.shownExecutionTrace = result;
                }
                resolve(result);
            }
            catch (e) {
                Log_1.Log.error("Error handling Execution Trace Request: " + e);
                resolve(result);
            }
        });
    });
    ServerClass_1.Server.connection.onNotification(ViperProtocol_1.Commands.StopVerification, (uri) => {
        try {
            let task = ServerClass_1.Server.verificationTasks.get(uri);
            task.abortVerification();
            ServerClass_1.Server.sendStateChangeNotification({
                newState: ViperProtocol_1.VerificationState.Ready,
                verificationCompleted: false,
                verificationNeeded: false,
                uri: uri
            }, task);
        }
        catch (e) {
            Log_1.Log.error("Error handling stop verification request: " + e);
        }
    });
    ServerClass_1.Server.connection.onNotification(ViperProtocol_1.Commands.StopDebugging, () => {
        try {
            DebugServer_1.DebugServer.stopDebugging();
        }
        catch (e) {
            Log_1.Log.error("Error handling stop debugging request: " + e);
        }
    });
    ServerClass_1.Server.connection.onRequest(ViperProtocol_1.Commands.ShowHeap, (params) => {
        try {
            let task = ServerClass_1.Server.verificationTasks.get(params.uri);
            if (!task) {
                Log_1.Log.error("No verificationTask found for " + params.uri);
                return;
            }
            ServerClass_1.Server.showHeap(task, params.clientIndex, params.isHeapNeeded);
        }
        catch (e) {
            Log_1.Log.error("Error showing heap: " + e);
        }
    });
    ServerClass_1.Server.connection.onRequest(ViperProtocol_1.Commands.GetDotExecutable, params => {
        return Settings_1.Settings.settings.paths.dotExecutable;
    });
}
function resetDiagnostics(uri) {
    let task = ServerClass_1.Server.verificationTasks.get(uri);
    if (!task) {
        Log_1.Log.error("no verification Task for file: " + uri);
        return;
    }
    task.resetDiagnostics();
}
//tries to restart backend, 
function restartBackendIfNeeded(oldSettings) {
    let newBackend = Settings_1.Settings.autoselectBackend(Settings_1.Settings.settings);
    if (newBackend) {
        //only restart the backend after settings changed if the active backend was affected
        let restartBackend = !ServerClass_1.Server.nailgunService.isReady() //backend is not ready -> restart
            || !Settings_1.Settings.backendEquals(ServerClass_1.Server.backend, newBackend) //change in backend
            || (oldSettings && (newBackend.useNailgun && (!Settings_1.Settings.nailgunEquals(Settings_1.Settings.settings.nailgunSettings, oldSettings.nailgunSettings)))); //backend needs nailgun and nailgun settings changed
        if (restartBackend) {
            Log_1.Log.log(`Change Backend: from ${ServerClass_1.Server.backend ? ServerClass_1.Server.backend.name : "No Backend"} to ${newBackend ? newBackend.name : "No Backend"}`, ViperProtocol_1.LogLevel.Info);
            ServerClass_1.Server.backend = newBackend;
            ServerClass_1.Server.verificationTasks.forEach(task => task.resetLastSuccess());
            ServerClass_1.Server.nailgunService.startOrRestartNailgunServer(ServerClass_1.Server.backend, true);
        }
        else {
            Log_1.Log.log("No need to restart backend. It is still the same", ViperProtocol_1.LogLevel.Debug);
            ServerClass_1.Server.backend = newBackend;
            ServerClass_1.Server.sendBackendReadyNotification({ name: ServerClass_1.Server.backend.name, restarted: false });
        }
    }
    else {
        Log_1.Log.error("No backend, even though the setting check succeeded.");
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VydmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc2VydmVyL3NyYy9zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsWUFBWSxDQUFDO0FBQ2IsNkRBQTZEO0FBQzdELDhFQUE4RTtBQUU5RSx3Q0FBcUYsdUJBQXVCLENBQUMsQ0FBQTtBQUM3RyxzQkFBa0IsT0FBTyxDQUFDLENBQUE7QUFDMUIsMkJBQXVCLFlBQ3ZCLENBQUMsQ0FEa0M7QUFDbkMsZ0NBQStILGlCQUMvSCxDQUFDLENBRCtJO0FBQ2hKLGlDQUE2QixrQkFBa0IsQ0FBQyxDQUFBO0FBQ2hELG1DQUErQixvQkFBb0IsQ0FBQyxDQUFBO0FBRXBELDhCQUEwQixlQUFlLENBQUMsQ0FBQTtBQUMxQyw4QkFBcUIsZUFBZSxDQUFDLENBQUE7QUFFckMsb0ZBQW9GO0FBQ3BGLG9CQUFNLENBQUMsVUFBVSxHQUFHLHdDQUFnQixDQUFDLElBQUksd0NBQWdCLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSx3Q0FBZ0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQ25HLG9CQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxvQkFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBRTNDLGdCQUFnQixFQUFFLENBQUM7QUFFbkIsMkJBQTJCO0FBQzNCLG9CQUFNLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBRTNCO0lBQ0ksZ0NBQWdDO0lBQ2hDLG9CQUFNLENBQUMsVUFBVSxDQUFDLFlBQVksQ0FBQyxDQUFDLE1BQU07UUFDbEMsSUFBSSxDQUFDO1lBQ0QseUJBQVcsQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUV6Qix5Q0FBeUM7WUFDekMsb0JBQU0sQ0FBQyxjQUFjLEdBQUcsSUFBSSwrQkFBYyxFQUFFLENBQUM7WUFDN0MsTUFBTSxDQUFDO2dCQUNILFlBQVksRUFBRSxFQUFFO2FBQ25CLENBQUE7UUFDTCxDQUFFO1FBQUEsS0FBSyxDQUFDLENBQUMs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