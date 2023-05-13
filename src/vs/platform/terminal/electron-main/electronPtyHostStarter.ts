/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { parsePtyHostDebugPort } from 'vs/platform/environment/node/environmentService';
import { ILifecycleMainService } from 'vs/platform/lifecycle/electron-main/lifecycleMainService';
import { ILogService } from 'vs/platform/log/common/log';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { IReconnectConstants } from 'vs/platform/terminal/common/terminal';
import { IPtyHostConnection, IPtyHostStarter } from 'vs/platform/terminal/node/ptyHost';
import { UtilityProcess } from 'vs/platform/utilityProcess/electron-main/utilityProcess';
import { Client as MessagePortClient } from 'vs/base/parts/ipc/electron-main/ipc.mp';
import { IpcMainEvent } from 'electron';
import { assertIsDefined } from 'vs/base/common/types';
import { validatedIpcMain } from 'vs/base/parts/ipc/electron-main/ipcMain';

export class ElectronPtyHostStarter implements IPtyHostStarter {

	private utilityProcess: UtilityProcess | undefined = undefined;

	constructor(
		private readonly _reconnectConstants: IReconnectConstants,
		@IEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@ILifecycleMainService private readonly _lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly _logService: ILogService
	) {
	}

	start(lastPtyId: number): IPtyHostConnection {
		this.utilityProcess = new UtilityProcess(this._logService, NullTelemetryService, this._lifecycleMainService);

		const inspectParams = parsePtyHostDebugPort(this._environmentService.args, this._environmentService.isBuilt);
		let execArgv: string[] | undefined = undefined;
		if (inspectParams) {
			execArgv = ['--nolazy'];
			if (inspectParams.break) {
				execArgv.push(`--inspect-brk=${inspectParams.port}`);
			} else if (!inspectParams.break) {
				execArgv.push(`--inspect=${inspectParams.port}`);
			}
		}

		this.utilityProcess.start({
			type: 'ptyHost',
			entryPoint: 'vs/platform/terminal/node/ptyHostMain',
			payload: this._createPtyHostConfiguration(lastPtyId),
			execArgv
		});

		const port = this.utilityProcess.connect();
		const client = new MessagePortClient(port, 'ptyHost');

		// Listen for new windows to establish connection directly to pty host
		validatedIpcMain.on('vscode:createPtyHostMessageChannel', (e, nonce) => this._onWindowConnection(e, nonce));

		return {
			client,
			port,
			connect: () => assertIsDefined(this.utilityProcess).connect(),
			dispose: client.dispose,
			onDidProcessExit: this.utilityProcess.onExit
		};
	}

	private _createPtyHostConfiguration(lastPtyId: number) {
		return {
			VSCODE_LAST_PTY_ID: lastPtyId,
			VSCODE_AMD_ENTRYPOINT: 'vs/platform/terminal/node/ptyHostMain',
			VSCODE_PIPE_LOGGING: 'true',
			VSCODE_VERBOSE_LOGGING: 'true', // transmit console logs from server to client,
			VSCODE_RECONNECT_GRACE_TIME: this._reconnectConstants.graceTime,
			VSCODE_RECONNECT_SHORT_GRACE_TIME: this._reconnectConstants.shortGraceTime,
			VSCODE_RECONNECT_SCROLLBACK: this._reconnectConstants.scrollback
		};
	}

	private _onWindowConnection(e: IpcMainEvent, nonce: string) {
		const port = this.utilityProcess!.connect();

		// Check back if the requesting window meanwhile closed
		// Since shared process is delayed on startup there is
		// a chance that the window close before the shared process
		// was ready for a connection.

		if (e.sender.isDestroyed()) {
			port.close();
			return;
		}

		e.sender.postMessage('vscode:createPtyHostMessageChannelResult', nonce, [port]);
	}
}
