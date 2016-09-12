'use strict'

import {IConnection, TextDocuments, PublishDiagnosticsParams} from 'vscode-languageserver';
import {Position, StepsAsDecorationOptionsResult, StateChangeParams, BackendReadyParams, Stage, HeapGraph, Backend, ViperSettings, Commands, VerificationState, VerifyRequest, LogLevel, ShowHeapParams} from './ViperProtocol'
import {NailgunService} from './NailgunService';
import {VerificationTask} from './VerificationTask';
import {Log} from './Log';

export class Server {
    static backend: Backend;
    static executedStages: Stage[];
    static stage(): Stage {
        if (this.executedStages && this.executedStages.length > 0) {
            return this.executedStages[this.executedStages.length - 1];
        }
        else return null;
    }
    static connection: IConnection;
    static documents: TextDocuments = new TextDocuments();
    static verificationTasks: Map<string, VerificationTask> = new Map();
    static nailgunService: NailgunService;
    static workspaceRoot: string;
    static debuggedVerificationTask: VerificationTask;

    static isViperSourceFile(uri: string): boolean {
        return uri.endsWith(".sil") || uri.endsWith(".vpr");
    }

    static showHeap(task: VerificationTask, clientIndex: number) {
        Server.connection.sendRequest(Commands.HeapGraph, task.getHeapGraphDescription(clientIndex));
    }

    //Communication requests and notifications sent to language client
    static sendStateChangeNotification(params: StateChangeParams) {
        this.connection.sendNotification(Commands.StateChange, params);
    }
    static sendBackendReadyNotification(params: BackendReadyParams) {
        this.connection.sendNotification(Commands.BackendReady, params);
    }
    static sendStopDebuggingNotification() {
        this.connection.sendNotification(Commands.StopDebugging);
    }
    static sendBackendChangeNotification(name: string) {
        this.connection.sendNotification(Commands.BackendChange, name);
    }
    static sendInvalidSettingsNotification(reason: string) {
        this.connection.sendNotification(Commands.InvalidSettings, reason);
    }
    static sendDiagnostics(params: PublishDiagnosticsParams) {
        this.connection.sendDiagnostics(params);
    }
    static sendStepsAsDecorationOptions(decorations: StepsAsDecorationOptionsResult) {
        Log.log("Update the decoration options (" + decorations.decorationOptions.length + ")", LogLevel.Debug);
        this.connection.sendNotification(Commands.StepsAsDecorationOptions, decorations);
    }
    static sendVerificationNotStartedNotification(uri: string) {
        this.connection.sendNotification(Commands.VerificationNotStarted, uri);
    }
    static uriToPath(uri: string): Thenable<string> {
        return this.connection.sendRequest(Commands.UriToPath, uri)
    }
    static pathToUri(path: string): Thenable<string> {
        return this.connection.sendRequest(Commands.PathToUri, path)
    }
    static sendFileOpenedNotification(uri: string) {
        this.connection.sendNotification(Commands.FileOpened, uri);
    }
    static sendFileClosedNotification(uri: string) {
        this.connection.sendNotification(Commands.FileClosed, uri);
    }

    //regex helper methods
    static extractNumber(s: string): number {
        try {
            let match = /^.*?(\d+)([\.,](\d+))?.*$/.exec(s);
            if (match && match[1] && match[3]) {
                return Number.parseFloat(match[1] + "." + match[3]);
            } else if (match && match[1]) {
                return Number.parseInt(match[1]);
            }
            Log.error(`Error extracting number from  "${s}"`);
            return 0;
        } catch (e) {
            Log.error(`Error extracting number from  "${s}": ${e}`);
        }
    }

    public static extractPosition(s: string, nonNull: boolean = true): { before: string, pos: Position, after: string } {
        let pos: Position;
        let before = "";
        let after = "";
        if (s) {
            pos = nonNull ? { line: 0, character: 0 } : null;
            let regex = /^(.*?)((\d+):(\d+)|<no position>)?:?(.*)$/.exec(s);
            if (regex && regex[3] && regex[4]) {
                //subtract 1 to confirm with VS Codes 0-based numbering
                let lineNr = Math.max(0, +regex[3] - 1);
                let charNr = Math.max(0, +regex[4] - 1);
                pos = { line: lineNr, character: charNr };
            }
            if (regex && regex[1]) {
                before = regex[1].trim();
            }
            if (regex && regex[5]) {
                after = regex[5].trim();
            }

        }
        return { before: before, pos: pos, after: after };
    }

    public static extractRange(startString: string, endString: string) {
        let start = Server.extractPosition(startString, false).pos;
        let end = Server.extractPosition(endString, false).pos;
        //handle uncomplete positions
        if (!end && start) {
            end = start;
        } else if (!start && end) {
            start = end;
        } else if (!start && !end) {
            start = { line: 0, character: 0 };
            end = start
        }
        return { start: start, end: end };
    }
}