/**
  * This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/.
  *
  * Copyright (c) 2011-2019 ETH Zurich.
  */

'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below



//============================================================================//
// NOTE: Before this extension can be launched, the path to a viper.jar
// must be set in Server.startLanguageServer in the file ExtensionState.ts!
// 
// NOTE: This extension only works with a version of ViperServer that includes
// an LSP frontend.
//============================================================================//

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as stripJSONComments from 'strip-json-comments';
import * as rimraf from 'rimraf';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { Timer } from './Timer';
import { State } from './ExtensionState';
import { SettingsError, HintMessage, SettingsErrorType, Commands, StateChangeParams, LogLevel, LogParams, ProgressParams, UnhandledViperServerMessageTypeParams, FlushCacheParams, Backend } from './ViperProtocol';
import { Log } from './Log';
import { StateVisualizer } from './StateVisualizer';
import { Helper } from './Helper';
import { ViperFormatter } from './ViperFormatter';
import { ViperFileState } from './ViperFileState';
import { locateViperTools } from './ViperTools';
import { Color } from './StatusBar';
import { VerificationController, TaskType, Task } from './VerificationController';
import { ViperApi } from './ViperApi';
import { Either, isRight, Level, Messages, Settings } from './Settings';
import { Location } from 'vs-verification-toolbox';

let autoSaver: Timer;

let fileSystemWatcher: vscode.FileSystemWatcher;
let formatter: ViperFormatter;

let activated: boolean = false;

// this method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<ViperApi> {
    return internalActivate(context)
        .catch(Helper.rethrow(`Activating the Viper-IDE extension has failed`));
}

async function internalActivate(context: vscode.ExtensionContext): Promise<ViperApi> {
    if (activated) {
        throw new Error(`Viper-IDE extension is already activated`);
    }
    
    Helper.loadViperFileExtensions();
    Log.log('The ViperIDE is starting up.', LogLevel.Info);
    let ownPackageJson = vscode.extensions.getExtension("viper-admin.viper").packageJSON;
    Log.log(`The current version of ${ownPackageJson.displayName} is: v.${ownPackageJson.version}`, LogLevel.Info);
    Log.initialize();
    State.context = context;
    State.initializeStatusBar(context);
    await cleanViperToolsIfRequested(context);
    const location = await locateViperTools(context);
    // check whether settings are correct and expected files exist:
    const settingsResult = await Settings.checkAndGetSettings(location);
    await handleSettingsCheckResult(settingsResult);
    State.verificationController = new VerificationController(location);
    fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/{' + Helper.viperFileEndings.join(",") + "}");
    await State.startLanguageServer(context, fileSystemWatcher, location);
    State.viperApi = new ViperApi(State.client);
    registerHandlers(location);
    startAutoSaver();
    registerFormatter();
    await initializeState(location);
    if (State.unitTest) State.unitTest.extensionActivated();
    activated = true;
    Log.log('Viper IDE is now active.', LogLevel.Info);
    return State.viperApi;
}

async function cleanViperToolsIfRequested(context: vscode.ExtensionContext): Promise<void> {
    // start of in a clean state by wiping Viper Tools if this was requested via
	// environment variables. In particular, this is used for the extension tests.
	if (Helper.cleanInstall()) {
        const globalStoragePath = Helper.getGlobalStoragePath(context);
        let files: string[] = [];
        if (fs.existsSync(globalStoragePath)) {
            // only read directory if it actually exists
            files = await fs.promises.readdir(globalStoragePath);
        }
        if (files.length === 0) {
            Log.log(`cleanInstall has been requested but viper tools do not exist yet --> NOP`, LogLevel.Info);
            return;
        }
        Log.log(`cleanInstall has been requested and viper tools already exist --> delete them`, LogLevel.Info);
        return new Promise((resolve, reject) => {
            // we do not delete `globalStoragePath` but only its content:
            rimraf(path.join(globalStoragePath, '*'), (err: Error) => {
                if (err == null) {
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
	}
}

export async function deactivate(): Promise<void> {
    return internalDeactivate()
        .catch(Helper.rethrow(`Deactivating the Viper-IDE extension has failed`));
}

async function internalDeactivate(): Promise<void> {
    if (!activated) {
        // extension is either not activated or has already been deactivated
        return;
    }
    activated = false;

    try {
        Log.log("deactivate", LogLevel.Info);
        await State.dispose();
        Log.log("State disposed", LogLevel.Debug);
        const oldFile = State.getLastActiveFile();
        if (oldFile) {
            Log.log("Removing special chars of last opened file.", LogLevel.Debug);
            await oldFile.stateVisualizer.removeSpecialCharacters();
        }
        Log.log("Close Log", LogLevel.Debug);
        Log.dispose();
        Log.log("Deactivated", LogLevel.Info)
    } catch (e) {
        Log.error("error disposing: " + e);
    }
}

/** deactivates and disposes extension and returns the extension context */
export async function shutdown(): Promise<vscode.ExtensionContext> {
    return internalShutdown()
        .catch(Helper.rethrow(`Shutting down the Viper-IDE extension has failed`));
}

async function internalShutdown(): Promise<vscode.ExtensionContext> {
    const context = State.context;
    // remove diagnostics as otherwise VSCode will show diagnostics of the extension's
    // current and next run
    removeDiagnostics(false);
    await deactivate();
    while (context.subscriptions.length > 0) {
        // remove first element (this avoid that we might dispose a subscription multiple times):
        const sub = context.subscriptions.shift();
        try {
            // note that everything can be awaited in JS / TS:
            await sub.dispose();
		} catch (e) {
			console.error(e);
		}
    }
    return context;
}

export async function restart(): Promise<void> {
    return internalRestart()
        .catch(Helper.rethrow(`Restarting the Viper-IDE extension has failed`));
}

async function internalRestart(): Promise<void> {
    const context = await shutdown();
    await activate(context);
}

function registerFormatter() {
    formatter = new ViperFormatter();
}

function toggleAutoVerify() {
    State.autoVerify = !State.autoVerify;
    State.statusBarItem.update("Auto Verify is " + (State.autoVerify ? "on" : "off"), Color.SUCCESS);
}

function startAutoSaver() {
    let autoSaveTimeout = 1000;//ms
    autoSaver = new Timer(() => {
        //only save viper files
        if (vscode.window.activeTextEditor != null && vscode.window.activeTextEditor.document.languageId == 'viper') {
            if (Settings.isAutoSaveEnabled()) {
                vscode.window.activeTextEditor.document.save();
            }
        }
    }, autoSaveTimeout);

    State.context.subscriptions.push(autoSaver);

    let onActiveTextEditorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(resetAutoSaver);
    let onTextEditorSelectionChange = vscode.window.onDidChangeTextEditorSelection(selectionChange => {
        if (Helper.isViperSourceFile(selectionChange.textEditor.document.uri)) {
            resetAutoSaver();
        }
    });
    State.context.subscriptions.push(onActiveTextEditorChangeDisposable);
    State.context.subscriptions.push(onTextEditorSelectionChange);
}

function resetAutoSaver() {
    autoSaver.reset();
}

async function initializeState(location: Location): Promise<void> {
    // set currently open file
    if (vscode.window.activeTextEditor) {
        const uri = vscode.window.activeTextEditor.document.uri;
        State.setLastActiveFile(uri, vscode.window.activeTextEditor);
        // this file is automatically verified as soo as the backend got started
    } else {
        Log.log("No active text editor found", LogLevel.Info);
    }
    
    // get backends from configuration and pick first one as the 'default' backend:
    const backends = await Settings.getVerificationBackends(location);
    if (backends.length === 0) {
        throw new Error("no verification backends configured in the settings");
    }
    // awaiting the following promise ensures that the extension is only marked as
    // ready when the default backend has already been set:
    await considerStartingBackend(backends[0]);

    // visually indicate that the IDE is now ready:
    State.statusBarItem.update("ready", Color.READY);
}

async function handleSettingsCheckResult(res: Either<Messages, {}>): Promise<void> {
    if (isRight(res)) {
        return; // success, i.e. no warnings and no errors
    }

    const msgs = res.left;
    let nofErrors = 0;
    let nofWarnings = 0;
    let message = "";
    msgs.forEach(msg => {
        switch (msg.level) {
            case Level.Error:
                nofErrors++;
                Log.error(`Settings Error: ${msg.msg}`, LogLevel.Info);
                break;
            case Level.Warning:
                nofWarnings++;
                Log.log(`Settings Warning: ${msg.msg}`, LogLevel.Info);
                break;
            default:
                nofErrors++; // we simply count it as an error
                Log.log(`Settings Warning or Error with unknown level '${msg.level}': ${msg.msg}`, LogLevel.Info);
                break;
        }
        message = msg.msg;
    })

    const countDescription = ((nofErrors > 0 ? ("" + nofErrors + " Error" + (nofErrors > 1 ? "s" : "")) : "") + (nofWarnings > 0 ? (" " + nofWarnings + " Warning" + (nofWarnings > 1 ? "s" : "")) : "")).trim();

    // update status bar
    Log.log(`${countDescription} detected.`, LogLevel.Info);
    if (nofErrors > 0) {
        State.statusBarItem.update(countDescription, Color.ERROR);
    } else if (nofWarnings > 0) {
        State.statusBarItem.update(countDescription, Color.WARNING);
    }

    // we can display one message, if there are more we redirect users to the output view:
    if (nofErrors + nofWarnings > 1) {
        message = "see View->Output->Viper";
    }
    Log.hint(`${countDescription}: ${message}`, `Viper Settings`, true, true);
    if (nofErrors > 0) {
        // abort only in the case of errors
        throw new Error(`Problems in Viper Settings detected`);
    }
}

function registerHandlers(location: Location) {
    State.client.onReady().then(ready => {

        State.client.onNotification(Commands.StateChange, (params: StateChangeParams) => State.verificationController.handleStateChange(params));
        
        State.client.onNotification(Commands.Hint, (data: HintMessage) => {
            Log.hint(data.message, "Viper", data.showSettingsButton, data.showViperToolsUpdateButton);
        });
        
        State.client.onNotification(Commands.Log, (params: LogParams) => {
            Log.log(params.data, params.logLevel, true);
        });
        
        State.client.onNotification(Commands.Progress, (params: ProgressParams) => {
            Log.progress(params.data, params.logLevel);
        });

        // When we don't know how to handle a message, we send it to whoever may be using the ViperApi, because this
        // unexpected message may have been destined for them.
        State.client.onNotification(
            Commands.UnhandledViperServerMessageType,
            (params: UnhandledViperServerMessageTypeParams) => { 
                Log.log(`Received non-standard ViperServer message of type ${params.msgType}.`, LogLevel.Default);
                State.viperApi.notifyServerMessage(params.msgType, params.msg);
            }
        );

        State.client.onRequest(Commands.GetIdentifier, (position) => {
            try {
                let range = vscode.window.activeTextEditor.document.getWordRangeAtPosition(new vscode.Position(position.line, position.character))
                let res = vscode.window.activeTextEditor.document.getText(range);
                if(res.indexOf(" ")> 0) return null
                //Log.log("GetIdentifier: " + res, LogLevel.LowLevelDebug);
                return res;
            } catch (e) {
                Log.error("Error getting indentifier: " + e);
                return null;
            }
        });

        State.client.onRequest(Commands.GetViperFileEndings, () => {
            Helper.loadViperFileExtensions();
            return Helper.viperFileEndings;
        });

        State.context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((params) => {
            try {
                State.addToWorklist(new Task({ type: TaskType.Save, uri: params.uri }));
            } catch (e) {
                Log.error("Error handling saved document: " + e);
            }
        }));
        State.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
            // basically all settings have some effect on ViperServer
            // only `advancedFeatures` might be fine to ignore but we simply restart ViperServer
            // for every configuration change:
            if (event.affectsConfiguration("viperSettings")) {
                await State.verificationController.stopDebuggingOnServer();
                await State.verificationController.stopDebuggingLocally();
                Log.updateSettings();
                Log.log(`Viper settings have been changed -> schedule an extension restart`, LogLevel.Info);
                State.addToWorklist(new Task({ type: TaskType.RestartExtension, uri: null, manuallyTriggered: false }));
            }
        }));

        //trigger verification texteditorChange
        State.context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async () => {
            try {
                let editor = vscode.window.activeTextEditor;
                if (editor) {
                    let uri = editor.document.uri;
                    if (Helper.isViperSourceFile(uri)) {
                        let oldViperFile: ViperFileState = State.getLastActiveFile();
                        if (oldViperFile) {
                            //change in active viper file, remove special characters from the previous one
                            if (oldViperFile.uri.toString() !== uri.toString()) {
                                oldViperFile.decorationsShown = false;
                                if (State.isDebugging) {
                                    await oldViperFile.stateVisualizer.removeSpecialCharsFromClosedDocument();
                                    await State.verificationController.stopDebuggingOnServer();
                                    await State.verificationController.stopDebuggingLocally();
                                }
                            }
                        }
                        let fileState = State.setLastActiveFile(uri, editor);
                        if (fileState) {
                            if (!fileState.verified) {
                                Log.log("The active text editor changed, consider reverification of " + fileState.name(), LogLevel.Debug);
                                State.addToWorklist(new Task({ type: TaskType.Verify, uri: uri, manuallyTriggered: false }));
                            } else {
                                Log.log("Don't reverify, the file is already verified", LogLevel.Debug);
                            }
                            Log.log("Active viper file changed to " + fileState.name(), LogLevel.Info);
                        }
                    }
                }
            } catch (e) {
                Log.error("Error handling active text editor change: " + e);
            }
        }));
        /*
        //Heap visualization
        State.client.onNotification(Commands.StepsAsDecorationOptions, params => {
            try {
                let castParams = <StepsAsDecorationOptionsResult>params;
                if (!castParams) {
                    Log.error("Invalid Params for StepsAdDecorationOptions");
                }
                let visualizer = State.getVisualizer(castParams.uri);
                visualizer.storeNewStates(castParams);
            } catch (e) {
                Log.error("Error handling steps as decoration options notification: " + e);
            }
        });

        State.client.onRequest(Commands.HeapGraph, (heapGraph: HeapGraph) => {
            try {
                if (!heapGraph) return;
                if (Settings.areAdvancedFeaturesEnabled()) {
                    let visualizer = State.getVisualizer(heapGraph.fileUri);
                    let state = visualizer.decorationOptions[heapGraph.state];
                    if (Settings.isSimpleModeEnabled()) {
                        //Simple Mode
                        if (state.isErrorState) {
                            //replace the error state
                            visualizer.focusOnState(heapGraph);
                        } else {
                            //replace the execution state
                            visualizer.setState(heapGraph);
                        }
                    } else {
                        //Advanced Mode
                        if (heapGraph.state != visualizer.previousState) {
                            visualizer.pushState(heapGraph);
                        }
                    }
                } else {
                    Log.log("WARNING: Heap Graph is generated, even though the advancedFeatures are disabled.", LogLevel.Debug);
                }
            } catch (e) {
                Log.error("Error displaying HeapGraph: " + e);
            }
        });
        */
        vscode.window.onDidChangeTextEditorSelection((change) => {
            try {
                if (!change.textEditor.document) {
                    Log.error("document is undefined in onDidChangeTextEditorSelection");
                    return;
                }
                let uri = change.textEditor.document.uri.toString();
                let start = change.textEditor.selection.start;
                let visualizer = State.getVisualizer(uri);
                if (visualizer) {
                    visualizer.showStateSelection(start);
                }
            } catch (e) {
                Log.error("Error handling text editor selection change: " + e);
            }
        });

        /*State.client.onRequest(Commands.StateSelected, change => {
            try {
                let castChange = <{ uri: string, line: number, character: number }>change;
                if (!castChange) {
                    Log.error("error casting stateSelected Request data");
                }
                let visualizer = State.viperFiles.get(castChange.uri).stateVisualizer;
                visualizer.showStateSelection({ line: castChange.line, character: castChange.character });
            } catch (e) {
                Log.error("Error handling state selected request: " + e);
            }
        });*/

        State.client.onNotification(Commands.VerificationNotStarted, uri => {
            try {
                Log.log("Verification not started for " + path.basename(<string>uri), LogLevel.Debug);
                //reset the verifying flag if it is not beeing verified
                State.viperFiles.forEach(file => {
                    file.verifying = false;
                });
                State.isVerifying = false;
                State.addToWorklist(new Task({ type: TaskType.VerificationFailed, uri: URI.parse(<string>uri), manuallyTriggered: true }));
            } catch (e) {
                Log.error("Error handling verification not started request: " + e);
            }
        });
        /*
        State.client.onNotification(Commands.StopDebugging, () => {
            State.verificationController.stopDebuggingLocally();
        });
        */

        //Command Handlers
        //verify
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.verify', () => {
            let fileUri = Helper.getActiveFileUri();
            if (!fileUri) {
                Log.log("Cannot verify, no document is open.", LogLevel.Info);
            } else if (!Helper.isViperSourceFile(fileUri)) {
                Log.log("Cannot verify the active file, its not a viper file.", LogLevel.Info);
            } else {
                State.addToWorklist(new Task({ type: TaskType.Verify, uri: fileUri, manuallyTriggered: true }));
            }
        }));

        //verifyAllFilesInWorkspace
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.verifyAllFilesInWorkspace', (folder) => State.verificationController.verifyAllFilesInWorkspace(folder)));

        //toggleAutoVerify
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.toggleAutoVerify', () => toggleAutoVerify()));

        //showAllStates
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.showAllStates', () => {
            if (State.isDebugging) {
                let viperFile = State.getLastActiveFile();
                if ((!Settings.isSimpleModeEnabled()) && viperFile) {
                    viperFile.stateVisualizer.showAllDecorations();
                }
            }
        }));

        State.context.subscriptions.push(vscode.commands.registerCommand('viper.flushCache', async () => flushCache(true)));

        State.context.subscriptions.push(vscode.commands.registerCommand('viper.flushCacheOfActiveFile', async () => flushCache(false)));

        //selectBackend
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.selectBackend', async (selectBackend) => {
            // get all backends from configuration:
            const backends = await Settings.getVerificationBackends(location);
            // user only needs to be asked if there is any choice:
            let selectedBackend: Backend = null;
            if (backends.length === 0) {
                // this path should not be possible because we check during startup that at least 1 backend is configured
                throw new Error(`0 verification backends are configured`);
            } else if (backends.length === 1) {
                selectedBackend = backends[0]; // there is no choice
            } else {
                // ask the user
                let selectedBackendName: string;
                if (selectBackend) {
                    // the user has provided a backend name already so don't ask again
                    selectedBackendName = selectBackend;
                } else {
                    // no argument provided and thus ask:
                    selectedBackendName = await vscode.window.showQuickPick(backends.map(backend => backend.name));
                }
                if (selectedBackendName) {
                    // user has choosen a backend
                    selectedBackend = backends.find(backend => backend.name === selectedBackendName);
                }
            }

            if (selectedBackend) {
                await considerStartingBackend(selectedBackend);
            } else {
                Log.log("No backend was selected, don't change the backend", LogLevel.Info);
            }
        }));

        //stopVerification
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.stopVerification', () => {
            State.addToWorklist(new Task({ type: TaskType.StopVerification, uri: null, manuallyTriggered: true }));
        }));

        //format
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.format', () => {
            try {
                formatter.formatOpenDoc();
            } catch (e) {
                Log.error("Error handling formating request: " + e);
            }
        }));

        //open logFile
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.openLogFile', openLogFile));

        //remove diagnostics of open file
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.removeDiagnostics', () => removeDiagnostics(true)));

        //automatic installation and updating of viper tools
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.updateViperTools', () => {
            State.addToWorklist(new Task({ type: TaskType.UpdateViperTools, uri: null, manuallyTriggered: true }));
        }));

        // show currently active (Viper) settings
        State.context.subscriptions.push(vscode.commands.registerCommand('viper.showSettings', async () => {
            const settings = vscode.workspace.getConfiguration("viperSettings");
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(settings, null, 2) });
            await vscode.window.showTextDocument(document, vscode.ViewColumn.Two);
        }));
    });
}

async function flushCache(allFiles: boolean) {
    const backend = State.activeBackend;
    if (!backend) {
        Log.hint("Cannot flush cache, no backend is active");
        return;
    }
    if (!allFiles) {
        const fileUri = Helper.getActiveFileUri();
        if (!fileUri) {
            Log.hint("Cannot flush cache, no active viper file found");
            return;
        }
        Log.log(`Request to flush the cache of ${path.basename(fileUri.fsPath)} and backend ${backend}`, LogLevel.Info);
        const params: FlushCacheParams = { uri: fileUri.fsPath, backend: backend.name };
        await State.client.sendRequest(Commands.FlushCache, params);
    } else {
        Log.log(`Request to flush the entire cache for backend ${backend}`, LogLevel.Info);
        const params: FlushCacheParams = { uri: null, backend: backend.name };
        await State.client.sendRequest(Commands.FlushCache, params);
    }
}

async function openLogFile(): Promise<void> {
    Log.log("Open logFile located at: " + Log.logFilePath, LogLevel.Info);
    const textDocument = await vscode.workspace.openTextDocument(Log.logFilePath)
        .then(Helper.identity, Helper.rethrow(`Error opening logFile`));
    if (!textDocument) {
        Log.hint("Cannot open the logFile, it is too large to be opened within VSCode.");
    } else {
        await vscode.window.showTextDocument(textDocument, vscode.ViewColumn.Two)
            .then(Helper.identity, Helper.rethrow(`vscode.window.showTextDocument call failed while opening the logfile`));
        Log.log("Showing logfile succeeded", LogLevel.Debug);
        if (State.unitTest) {
            State.unitTest.logFileOpened();
        }
    }
}

function considerStartingBackend(newBackend: Backend): Promise<void> {
    /*
    if (newBackend && (!State.isBackendReady || State.activeBackend.name != newBackend.name)) {
        State.addToWorklist(new Task({
            type: TaskType.StartBackend,
            backend: newBackend,
            manuallyTriggered: true,
            forceRestart: false,
        }));
    } else {
        Log.log("No need to restart backend " + newBackend.name, LogLevel.Info);
    }*/
    // we can't compare `newBackend` with the currently active backend because
    // there might be other `StartBackend` tasks in the worklist
    return new Promise((resolve, reject) => {
        State.addToWorklist(new Task({
            type: TaskType.StartBackend,
            backend: newBackend,
            manuallyTriggered: true,
            forceRestart: false,
            resolve: resolve,
            reject: reject,
        }));
    });
}

async function showStates(): Promise<void> {
    try {
        if (Settings.areAdvancedFeaturesEnabled()) {
            if (!StateVisualizer.showStates) {
                StateVisualizer.showStates = true;
                const visualizer = State.getLastActiveFile().stateVisualizer;
                await visualizer.removeSpecialCharacters();
                await visualizer.addCharacterToDecorationOptionLocations();
                visualizer.showDecorations();
            } else {
                Log.log("don't show states, they are already shown", LogLevel.Debug);
            }
        }
    } catch (e) {
        Log.error("Error showing States: " + e);
    }
}

function removeDiagnostics(activeFileOnly: boolean) {
    if (activeFileOnly) {
        if (vscode.window.activeTextEditor) {
            const uri = vscode.window.activeTextEditor.document.uri;
            State.diagnosticCollection.delete(uri);
            Log.log(`Diagnostics successfully removed for file ${uri}`, LogLevel.Debug);
        }
    } else {
        State.diagnosticCollection.clear();
        Log.log(`All diagnostics successfully removed`, LogLevel.Debug);
    }
}

const settings = [
    "viperSettings.viperServerSettings",
    "viperSettings.paths",
    "viperSettings.preferences",
    "viperSettings.javaSettings",
    "viperSettings.advancedFeatures"]

//check if each specified viper setting has a v field in the file located at path 
function checkSettingsFile(path: string): SettingsError[] {
    let errors: SettingsError[] = [];
    let content = fs.readFileSync(path).toString();
    if (content) {
        let json = JSON.parse(stripJSONComments(content));
        if (json) {
            //check objects
            settings.forEach(viperSetting => {
                if (json[viperSetting] && !json[viperSetting].v) {
                    errors.push({
                        type: SettingsErrorType.Error,
                        msg: viperSetting + " is missing a v field."
                    })
                }
            });
            //check arrays
            let backendSettings = "viperSettings.verificationBackends";
            if (json[backendSettings]) {
                json[backendSettings].forEach(backend => {
                    if (backend && !backend.v) {
                        errors.push({
                            type: SettingsErrorType.Error,
                            msg: "backend " + backend.name + " is missing a v field."
                        })
                    }
                });
            }
        }
    }
    return errors;
}

function getUserSettingsPath(): string {
    let userSettingsPath;
    if (State.isWin) {
        userSettingsPath = path.join(process.env['APPDATA'], "Code", "User", "settings.json");
    } else if (State.isLinux) {
        userSettingsPath = path.join(os.homedir(), ".config", "Code", "User", "settings.json");
    } else {
        userSettingsPath = path.join(os.homedir(), "Library", "Application Support", "Code", "User", "settings.json");
    }
    return userSettingsPath;
}
function getWorkspaceSettingsPath(): string {
    if (vscode.workspace.workspaceFolders) {
        return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".vscode", "settings.json");
    }
    return;
}
