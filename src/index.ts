const request = require('request');
const mysqlDump = require('wi-sqldump');
const findRemoveSync = require('find-remove');
const sftpClient = require('ssh2-sftp-client');
const fs = require('fs');

import * as Utils from "./utils";
import * as Constants from "./constants";
import { MySQLConfigType, SFTPConfigType, ReturnObject } from "./types";

/**
 * Base class
 */
module.exports = class Backup {
	private mySqlConfig: MySQLConfigType;
	private sftpConfig: SFTPConfigType;
	private backupDir: string;
	private outputMode: boolean;
	private debugMode: boolean;
	private webhookMode: boolean;
	private webhookURL: string;

	/**
	 * Constructor for Backup class, validates and initializes data
	 * @param _config MySQL Connection config
	 * @param _outputMode Log program output in console
	 * @param _debugMode Log debug output in console
	 * @param _webhookMode Enable or disable webhooks
	 */
	constructor(_config: Object, _backupDir: string, _outputMode: boolean, _debugMode: boolean, _webhookMode: boolean) {
		let validated = this.validateConfig(_config);
		if (!validated) return; // Exit if invalid MySQL config

		this.backupDir = _backupDir;
		this.outputMode = _outputMode || this.debugMode; // Active if debugMode is on
		this.debugMode = _debugMode;
		this.webhookMode = _webhookMode;

	}

	/**
	 * Creates a backup at the specified file location and returns results
	 * @param fileName Path for backup file location
	 * @returns ReturnObject with info on backup result
	 */
	public createBackup = async (fileName: string): Promise<ReturnObject> => {
		return new Promise((resolve, reject) => {
			// Create backup at specified path
			mysqlDump({
				...this.mySqlConfig,
				dest: `${fileName}.sql`
			}, async (err: any) => {
				let result: ReturnObject;
				// Notify if backup failed with errors
				if (err) {
					let errorString = `Error while taking backup at ${Date.now()} to: ${fileName}.sql\nError:\n${err}`;
					result = {
						message: errorString,
						success: false
					}
					this.sendOutputLog(`Error while taking backup at ${Date.now()} to: ${fileName}.sql`)
					this.sendDebugLog(result.message);
					reject(result);
				} else {
					let successString = `Backup taken at ${Date.now()} to: ${fileName}.sql`;
					result = {
						message: successString,
						success: true
					}
					this.sendOutputLog(result.message);
					resolve(result);
				}
			})
		});
	}

	/**
	 * Method to run a remote backup to configured server
	 * @param localFilePath Path to local backup file
	 * @param remoteFilePath Path to remote backup location
	 * @returns ReturnObject
	 */
	public remoteBackup = async (localFilePath: string, remoteFilePath: string): Promise<ReturnObject> => {
		return new Promise((resolve, reject) => {
			let result: ReturnObject;
			// If no SFTP config has been set up
			if (!this.sftpConfig) {
				result = { message: `No SFTP config has been supplied!`, success: false }
				this.sendDebugLog(result.message);
				reject(result);
			}
			// Check if file exists
			fs.open(localFilePath, 'r', async (err: any) => {
				if (err) {
					this.sendOutputLog(`Error creating remote backup!`);
					// If file does not exist
					if (err.code == 'ENOENT') {
						result = { message: `${localFilePath} does not exist in the current directory!`, success: false }
						this.sendDebugLog(`Could not find file: ${localFilePath}`);
					}
					// If other error while opening file
					else {
						result = { message: `Error while opening file ${localFilePath}:\n${err}`, success: false }
						this.sendDebugLog(result.message);
					}
					reject(result);
				}
				// Create connection
				const client: any = new sftpClient();
				client.connect({
					...this.sftpConfig
				}).then(async () => {
					this.sendDebugLog(`Connected to remote server ${this.sftpConfig.host}. Transferring files...`);
					try {
						// Transfer file from local path to remote path
						await client.put(localFilePath, remoteFilePath);
						result = { message: `Files successfully transferred to ${this.sftpConfig.host}!`, success: true }
						this.sendOutputLog(result.message);
					} catch (err) {
						result = { message: `Error while transferring files to ${this.sftpConfig.host}:\n${err}`, success: false }
						this.sendDebugLog(result.message);
					}
					// End the connection after transfer is complete
					client.end();
					this.sendDebugLog(`Connection to ${this.sftpConfig.host} closed.`);
					if (result.success) resolve(result);
					else reject(result);
				}).catch((err: any) => {
					// If there is an error connecting to remote server
					result = { message: `Error while connecting to remote server ${this.sftpConfig.host}:\n${err}`, success: false }
					this.sendDebugLog(result.message);
					reject(result);
				});
			})
		})
	}

	/**
	 * Sets the remote server SFTP config
	 * @param configObj SFTP Config
	 * @returns ReturnObject
	 */
	public setRemoteServer = (configObj: Object): ReturnObject => {
		let result: ReturnObject;
		if (this.validateConfig(configObj)) {
			result = {
				message: "Updated Remote Server config.",
				success: true
			};
		} else {
			result = {
				message: "Failed updating Remote Server config.",
				success: false
			};
		}
		return result;
	}

	/**
	 * Helper method to delete old backup files
	 * @param age Minimum age of files to remove, in seconds
	 * @returns Number of files removed
	 */
	public removeOldBackups = (age: number): number => {
		let result = findRemoveSync(this.backupDir, {
			age: { seconds: age },
			extentions: '.sql'
		});
		let removedFiles = Object.keys(result).length;
		this.sendOutputLog(`Deleted a total of ${removedFiles} old backups.`);
		return removedFiles;
	}

	/**
	 * Helper method to set the output webhook
	 * @param url Webhook URL
	 */
	public setWebhook = (url: string): void => {
		if (Utils.isValidWebhookURL(url)) {
			this.webhookURL = url;
			this.sendDebugLog("Webhook set to: " + url);
		} else {
			this.sendDebugLog("Invalid webhook link provided!");
		}
	}

	/**
	 * Helper method to return current webhook URL
	 * @returns Webhook URL
	 */
	public getWebhook = (): string => {
		return this.webhookURL;
	}

	/**
	 * Enables webhook
	 */
	public enableWebook = (): void => {
		this.webhookMode = true;
		this.sendDebugLog("Webhook enabled");
	}

	/**
	 * Disables webhook
	 */
	public disableWebook = (): void => {
		this.webhookMode = false;
		this.sendDebugLog("Webhook disabled");
	}

	/**
	 * @returns If webhook is active
	 */
	public isWebhookEnabled = (): boolean => {
		return this.webhookMode;
	}

	/**
	 * Helper method to send a webhook message
	 * @param message Webhook message to send
	 */
	private sendWebhook = (message: string): void => {
		if (!this.webhookMode) return;
		if (!this.getWebhook()) {
			this.sendDebugLog("Failed sending webhook: No webhook config set up.")
			return;
		}
		request.post(this.getWebhook, {
			form: {
				content: `💾 ${message}`
			},
			headers: {
				'Conent-Type': 'application/x-www-form-urlencoded'
			}
		}, (err: any) => {
			if (err) {
				this.sendOutputLog('Error sending webhook: ' + err.message);
			}
		})
	}

	/**
	 * Helper method to validate a MySQL connection config object and return a constructed MySQLConfig type
	 * @param config MySQL connection config object
	 * @returns Constructed MySQLConfig type
	 */
	private validateConfig = (configObject: any): boolean => {
		// Check for invalid keys or invalid types
		const errors: Array<Error> = Object.keys(configObject)
			.filter(key => {
				return !Constants.requiredMySQLConfigFields.includes(key) || typeof configObject[key] != 'string'
			})
			.map(key => {
				return new Error(`${key} is an invalid MySQL config key.`)
			})
		// Check for missing keys
		if (Object.keys(configObject).sort().toString() != Constants.requiredMySQLConfigFields.sort().toString()) {
			errors.push(new Error(`Missing values in MySQL config.`));
		}
		// If invalid keys found, display errors and exit
		if (errors.length) {
			for (const err of errors) {
				this.sendDebugLog(err.message);
			}
			this.sendDebugLog("Invalid MySQL Config");
			return false;
		}
		// If keys are valid, set class config to new MySQLConfigType with config data
		else {
			this.mySqlConfig = {
				host: configObject.host,
				user: configObject.user,
				password: configObject.password,
				database: configObject.database
			};
			this.sendDebugLog("MySQL Config Validated");
			return true;
		}
	}

	/**
	 * Helper method to log output to console
	 * @param message Message to log out
	 */
	private sendOutputLog = (message: string) => {
		if (this.outputMode) {
			console.log(`[MySQL Backup Log] ${message}`);
		}
		this.sendWebhook(message);
	}

	/**
	 * Helper method to log debug output to console
	 * @param message Debug message to log out
	 */
	private sendDebugLog = (message: string) => {
		if (this.debugMode) {
			console.log(`[MySQL Backup Debug Log] ${message}`);
		}
	}

}