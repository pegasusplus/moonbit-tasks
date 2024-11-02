import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsPromises } from 'fs';

import * as helper from './helper';
import * as langDef from './language_def';

let myTerminal: vscode.Terminal | undefined;

async function smartGetProjectPath(fileDir: string): Promise<langDef.handlerInfo | undefined> {
	if (fileDir.length > 0) {
		for (let [languageName, cmdHandler] of langDef.languageHandlerMap) {
			if (langDef.handlerInfo.isValid(cmdHandler) && helper.isValidString(cmdHandler.signatureFileName)) {
				let fSigFileFound = false;
				try {
					if (cmdHandler.signatureFileName[0] !== '*') {
						const targetFilePath = path.join(fileDir, cmdHandler.signatureFileName);
						await fsPromises.access(targetFilePath);
						fSigFileFound = true;
					}
					else {
						fSigFileFound = await searchFilesByExtension(fileDir, cmdHandler.signatureFileName);
					}
				}
				catch (e) {
					//const fsErr = e as fs.FileError
					if (!`${e}`.startsWith('Error: ENOENT')) {
						vscode.window.showWarningMessage(`Search for project signature file failed: ${e}`);
					}
				}

				if (fSigFileFound) {
					return cmdHandler;
				}
			}
		}
	}

	return undefined;
}

/// Just search files within a dir, no subdir yet
/// extensions can be written as '*.nimble|*.json|*.csproj'
async function searchFilesByExtension(folderPath: string, extensionExp: string): Promise<boolean> {
	// const extensionExp = '*.a|*.b|*.c';
	const extensions = extensionExp.split('|').map(item => item.slice(1));
	
	try {
		let files = await fsPromises.readdir(folderPath);
		for (const file of files) {
			const fullPath = path.join(folderPath, file);
			const stats = await fsPromises.stat(fullPath);
			if (stats.isDirectory()) {
				// Recursive search if needed
			}
			else {
				for (let ext of extensions) {
					if (file.endsWith(ext)) {
						return true;
					}
				}				
			}
		}
	}
	catch(e) {
		if (!`${e}`.startsWith('Error: ENOENT')) {
			vscode.window.showWarningMessage(`Search signature files by extension failed: ${e}`);
		}
	}

	return false;
}

/// If current file is a signature, or a signature in current dir or current project root dir or any project root dir, do the task 
export async function smartTaskRun(cmd: string) {
	let projectDir :string|undefined;
	let handler :langDef.handlerInfo|undefined;
	//let languageName :string|undefined;

	// Get the current active file in the Explorer
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const filePath = activeEditor.document.uri.fsPath;
		const fileDir = path.dirname(filePath);  // Get the directory of the current file
		try {
			({ projectDir, handler } = checkSignatureForActiveFile(activeEditor, projectDir, fileDir, handler));

			if (langDef.handlerInfo.notValid(handler)) {
				({ handler, projectDir } = await searchSignatureAtCurrentDirForActiveFile(fileDir, handler, projectDir));
			}

			if (langDef.handlerInfo.notValid(handler)) {
				// The root path that contain current document
				// Get the workspace folders
				({ handler, projectDir } = await searchSignatureFromWorkSpace(fileDir, handler, projectDir));
			}
		} catch (err) {
			vscode.window.showWarningMessage(`Error occurred while searching project signature file: ${err}`);
		}
	} else {
		vscode.window.showWarningMessage("No active file found.");
	}

	if (helper.isValidString(projectDir) && langDef.handlerInfo.isValid(handler)) {
		vscode.window.showInformationMessage(`Running ${handler?.projectManagerCmd} in: ${projectDir}`);

		// Example shell command to be executed in the current file's directory
		const shellCommand = handler?.getFullCmd(cmd);

		// Run the shell command in the file's directory
		runCmdInTerminal(shellCommand, projectDir);
	}
	else {
		vscode.window.showWarningMessage(`Can't find any project signature file.`);
	}
}

async function searchSignatureFromWorkSpace(fileDir: string, handler: langDef.handlerInfo | undefined, projectDir: string | undefined) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders !== undefined && workspaceFolders !== null) {
		// Check each workspace folder to see if the file is in it and keep the folder that has maximum length
		let rootDir: vscode.WorkspaceFolder | undefined = undefined;
		const firstFoundRootDir = workspaceFolders.find(folder => {
			return true;
			//const folderPath = folder.uri.fsPath;
			//return fileDir.startsWith(folderPath);  // Check if the file is within this folder
		});
		rootDir = firstFoundRootDir;
		let maxPathLength = 0;
		//let maxPathRoot: vscode.WorkspaceFolder | undefined = undefined;
		workspaceFolders.forEach(folder => {
			const pathLength = folder.uri.fsPath.length;
			if (fileDir.startsWith(folder.uri.fsPath) && pathLength > maxPathLength) {
				//maxPathRoot = folder;
				maxPathLength = pathLength;
				//rootDir = maxPathRoot;
				rootDir = folder;
			}
		});
		// if (maxPathRoot !== undefined && maxPathRoot !== null) {
		// 	rootDir = firstFoundRootDir;
		// 	//rootDir = maxPathRoot; // ? maxPathRoot : undefined;
		// }
		if (rootDir !== undefined && rootDir !== null && rootDir.uri.fsPath.length > 0) {
			handler = await smartGetProjectPath(rootDir.uri.fsPath);
			if (langDef.handlerInfo.isValid(handler)) {
				projectDir = rootDir.uri.fsPath;
			}
			else {
				for (let folder of workspaceFolders) {
					handler = await smartGetProjectPath(folder.uri.fsPath);
					if (langDef.handlerInfo.isValid(handler)) {
						projectDir = folder.uri.fsPath;
						break;
					}
				}
			}
		}
	}
	return { handler, projectDir };
}

async function searchSignatureAtCurrentDirForActiveFile(fileDir: string, handler: langDef.handlerInfo | undefined, projectDir: string | undefined) {
	let currentFolder = fileDir;
	while (true) {
		handler = await smartGetProjectPath(currentFolder);
		if (langDef.handlerInfo.isValid(handler)) {
			projectDir = currentFolder;
		}
		else {
			const parentFolder = path.dirname(currentFolder);
			if (parentFolder.length < currentFolder.length) {
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders !== undefined && workspaceFolders !== null) {
					const firstFoundRootDir = workspaceFolders.find(folder => {
						return parentFolder.startsWith(folder.uri.fsPath); // Check if the file is within this folder
					});
					if (firstFoundRootDir !== undefined) {
						currentFolder = parentFolder;
						continue;
					}
				}
			}
		}
		break;
	}
	return { handler, projectDir };
}

function checkSignatureForActiveFile(activeEditor: vscode.TextEditor, projectDir: string | undefined, fileDir: string, handler: langDef.handlerInfo | undefined) {
	for (let [_languageName, cmdHandler] of langDef.languageHandlerMap) {
		// *.nimble
		if (langDef.handlerInfo.isValid(cmdHandler) && helper.isValidString(cmdHandler.signatureFileName)) {
			let fSigFileFound = false;
			if (cmdHandler.signatureFileName[0] !== '*') {
				fSigFileFound = cmdHandler.signatureFileName == path.basename(activeEditor.document.fileName);
			}
			else {
				const extensions = cmdHandler.signatureFileName.split('|').map(item => item.slice(1));
				for (let ext of extensions) {
					if (path.basename(activeEditor.document.fileName).endsWith(ext)) {
						fSigFileFound = true;
						break;
					}
				}

				// extension search will be done at stage 2. First stage just check current active file
				//fSigFileFound = await searchFilesByExtension(fileDir, cmdHandler.signatureFileName);
			}

			if (fSigFileFound) {
				projectDir = fileDir;
				handler = cmdHandler;
				break;
			}
		}
	}
	return { projectDir, handler };
}

function runCmdInTerminal(cmd: string | undefined, cwd: string|undefined) {
	function getShellPath(): string {
		const os = require("os");
		if (os.platform() === 'win32') {
			return 'cmd.exe';
		} else if (os.platform() === 'darwin') {
			return '/bin/zsh';
		} else {
			return '/bin/bash';
		}
	}

	if (!myTerminal || myTerminal.exitStatus) {
		myTerminal = vscode.window.createTerminal({
			name:'Moonbit-tasks extention Terminal',
			shellPath:getShellPath(),
			iconPath:new vscode.ThemeIcon('tools')
		});
	}

	myTerminal.show();  // Show the terminal

	// Run a shell command in the terminal
	if (helper.isValidString(cwd)) {
		// Need check if diectory exists?
		myTerminal.sendText(`cd "${cwd}"`);
	}
	else {
		vscode.window.showErrorMessage("Invalid CWD for command");
	}

	if (helper.isValidString(cmd)) {
		myTerminal.sendText(cmd?cmd:"");
	}
	else {
		vscode.window.showErrorMessage("Invalid CMD for task");
	}
}
