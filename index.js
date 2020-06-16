'use strict';
const path = require('path');
const childProcess = require('child_process');
const crossSpawn = require('cross-spawn');
const stream = require('stream');
const stripFinalNewline = require('strip-final-newline');
const npmRunPath = require('npm-run-path');
const onetime = require('onetime');
const makeError = require('./lib/error');
const normalizeStdio = require('./lib/stdio');
const {spawnedKill, spawnedCancel, setupTimeout, setExitHandler} = require('./lib/kill');
const {handleInput, getSpawnedResult, makeAllStream, validateInputSync} = require('./lib/stream.js');
const {mergePromise, getSpawnedPromise} = require('./lib/promise.js');
const {joinCommand, parseCommand} = require('./lib/command.js');

const DEFAULT_MAX_BUFFER = 1000 * 1000 * 100;

const getEnv = ({env: envOption, extendEnv, preferLocal, localDir, execPath}) => {
	const env = extendEnv ? {...process.env, ...envOption} : envOption;

	if (preferLocal) {
		return npmRunPath.env({env, cwd: localDir, execPath});
	}

	return env;
};

const handleArgs = (file, args, options = {}) => {
	const parsed = crossSpawn._parse(file, args, options);
	file = parsed.command;
	args = parsed.args;
	options = parsed.options;

	options = {
		maxBuffer: DEFAULT_MAX_BUFFER,
		buffer: true,
		stripFinalNewline: true,
		extendEnv: true,
		preferLocal: false,
		localDir: options.cwd || process.cwd(),
		execPath: process.execPath,
		encoding: 'utf8',
		reject: true,
		cleanup: true,
		all: false,
		windowsHide: true,
		...options
	};

	options.env = getEnv(options);

	options.stdio = normalizeStdio(options);

	if (process.platform === 'win32' && path.basename(file, '.exe') === 'cmd') {
		// #116
		args.unshift('/q');
	}

	return {file, args, options, parsed};
};

const handleOutput = (options, value, error) => {
	if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
		// When `execa.sync()` errors, we normalize it to '' to mimic `execa()`
		return error === undefined ? undefined : '';
	}

	if (options.stripFinalNewline) {
		return stripFinalNewline(value);
	}

	return value;
};

const execa = (file, args, options) => {
	const parsed = handleArgs(file, args, options);
	const command = joinCommand(file, args);

	let spawned;
	try {
		spawned = childProcess.spawn(parsed.file, parsed.args, parsed.options);
	} catch (error) {
		// Ensure the returned error is always both a promise and a child process
		const dummySpawned = new childProcess.ChildProcess();
		const errorPromise = Promise.reject(makeError({
			error,
			stdout: '',
			stderr: '',
			all: '',
			command,
			parsed,
			timedOut: false,
			isCanceled: false,
			killed: false
		}));
		return mergePromise(dummySpawned, errorPromise);
	}

	const spawnedPromise = getSpawnedPromise(spawned);
	const timedPromise = setupTimeout(spawned, parsed.options, spawnedPromise);
	const processDone = setExitHandler(spawned, parsed.options, timedPromise);

	const context = {isCanceled: false};

	spawned.kill = spawnedKill.bind(null, spawned.kill.bind(spawned));
	spawned.cancel = spawnedCancel.bind(null, spawned, context);

	const handlePromise = async () => {
		const [{error, exitCode, signal, timedOut}, stdoutResult, stderrResult, allResult] = await getSpawnedResult(spawned, parsed.options, processDone);
		const stdout = handleOutput(parsed.options, stdoutResult);
		const stderr = handleOutput(parsed.options, stderrResult);
		const all = handleOutput(parsed.options, allResult);

		if (error || exitCode !== 0 || signal !== null) {
			const returnedError = makeError({
				error,
				exitCode,
				signal,
				stdout,
				stderr,
				all,
				command,
				parsed,
				timedOut,
				isCanceled: context.isCanceled,
				killed: spawned.killed
			});

			if (!parsed.options.reject) {
				return returnedError;
			}

			throw returnedError;
		}

		return {
			command,
			exitCode: 0,
			stdout,
			stderr,
			all,
			failed: false,
			timedOut: false,
			isCanceled: false,
			killed: false
		};
	};

	const handlePromiseOnce = onetime(handlePromise);

	crossSpawn._enoent.hookChildProcess(spawned, parsed.parsed);

	handleInput(spawned, parsed.options.input);

	spawned.all = makeAllStream(spawned, parsed.options);

	return mergePromise(spawned, handlePromiseOnce);
};

module.exports = execa;

module.exports.sync = (file, args, options) => {
	const parsed = handleArgs(file, args, options);
	const command = joinCommand(file, args);

	validateInputSync(parsed.options);

	let result;
	try {
		result = childProcess.spawnSync(parsed.file, parsed.args, parsed.options);
	} catch (error) {
		throw makeError({
			error,
			stdout: '',
			stderr: '',
			all: '',
			command,
			parsed,
			timedOut: false,
			isCanceled: false,
			killed: false
		});
	}

	const stdout = handleOutput(parsed.options, result.stdout, result.error);
	const stderr = handleOutput(parsed.options, result.stderr, result.error);

	if (result.error || result.status !== 0 || result.signal !== null) {
		const error = makeError({
			stdout,
			stderr,
			error: result.error,
			signal: result.signal,
			exitCode: result.status,
			command,
			parsed,
			timedOut: result.error && result.error.code === 'ETIMEDOUT',
			isCanceled: false,
			killed: result.signal !== null
		});

		if (!parsed.options.reject) {
			return error;
		}

		throw error;
	}

	return {
		command,
		exitCode: 0,
		stdout,
		stderr,
		failed: false,
		timedOut: false,
		isCanceled: false,
		killed: false
	};
};

module.exports.command = (command, options) => {
	const [file, ...args] = parseCommand(command);
	return execa(file, args, options);
};

module.exports.commandSync = (command, options) => {
	const [file, ...args] = parseCommand(command);
	return execa.sync(file, args, options);
};

module.exports.node = (scriptPath, args, options = {}) => {
	if (args && !Array.isArray(args) && typeof args === 'object') {
		options = args;
		args = [];
	}

	const stdio = normalizeStdio.node(options);

	const {nodePath = process.execPath, nodeOptions = process.execArgv} = options;

	return execa(
		nodePath,
		[
			...nodeOptions,
			scriptPath,
			...(Array.isArray(args) ? args : [])
		],
		{
			...options,
			stdin: undefined,
			stdout: undefined,
			stderr: undefined,
			stdio,
			shell: false
		}
	);
};

module.exports.duplexStream = (file, args, options) => {
	const parsed = handleArgs(file, args, options);
	const command = joinCommand(file, args);

	let spawned;
	try {
		spawned = childProcess.spawn(parsed.file, parsed.args, parsed.options);
	} catch (error) {
		const errorPromise = Promise.reject(makeError({
			error,
			stdout: undefined,
			stderr: undefined,
			all: undefined,
			command,
			parsed,
			timedOut: false,
			isCanceled: false,
			killed: false
		}));

		// We don't require the caller to handle the rejection since errors
		// will be translated into pipe/pipeline failure
		errorPromise.catch(() => {});

		const dummyDuplex = new stream.Duplex({
			read() {
				this.destroy(error);
			},
			write(chunk, encoding, callback) {
				callback(error);
			}
		});

		return mergePromise(dummyDuplex, errorPromise);
	}

	const spawnedPromise = getSpawnedPromise(spawned);
	const timedPromise = setupTimeout(spawned, parsed.options, spawnedPromise);
	const processDone = (async () => {
		try {
			return await setExitHandler(spawned, parsed.options, timedPromise);
		} catch (error) {
			return {error, signal: error.signal, timedOut: error.timedOut};
		}
	})();

	const context = {isCanceled: false};

	spawned.kill = spawnedKill.bind(null, spawned.kill.bind(spawned));
	spawned.cancel = spawnedCancel.bind(null, spawned, context);

	crossSpawn._enoent.hookChildProcess(spawned, parsed.parsed);

	const all = makeAllStream(spawned, parsed.options);
	const {stdin} = spawned;
	const output = all ? all : spawned.stdout;

	const duplex = new stream.Duplex({
		autoDestroy: false,
		write(chunk, encoding, callback) {
			stdin.write(chunk, encoding, callback);
		},
		final(callback) {
			stdin.end(callback);
		},
		read() {
			output.resume();
		},
		destroy(error, callback) {
			if (spawned.exitCode === null && spawned.signalCode === null) {
				spawned.once('exit', () => {
					callback(error);
				});

				spawned.once('error', () => {
					callback(error);
				});

				spawned.cancel();
			} else {
				callback(error);
			}
		}
	});

	stdin.once('error', error => {
		duplex.destroy(error);
	});

	output.once('error', error => {
		duplex.destroy(error);
	});

	output.once('end', async () => {
		const {error, exitCode, signal} = await processDone;
		if (!error && exitCode === 0 && signal === null) {
			duplex.push(null);
		}
	});
	output.on('data', chunk => {
		if (!duplex.push(chunk)) {
			output.pause();
		}
	});

	const result = (async () => {
		const {error, exitCode, signal, timedOut} = await processDone;
		if (error || exitCode !== 0 || signal !== null) {
			const returnedError = makeError({
				error,
				exitCode,
				signal,
				stdout: undefined,
				stderr: undefined,
				all: undefined,
				command,
				parsed,
				timedOut,
				isCanceled: context.isCanceled,
				killed: spawned.killed
			});

			throw returnedError;
		}

		return {
			command,
			exitCode: 0,
			stdout: undefined,
			stderr: undefined,
			all: undefined,
			failed: false,
			timedOut: false,
			isCanceled: false,
			killed: false
		};
	})();

	(async () => {
		const promisesResult = (await Promise.all([
			(async () => {
				try {
					await result;
					return null;
				} catch (error) {
					return error;
				}
			})(),
			new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
				stdin.on('close', resolve);
			}),
			new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
				output.on('close', resolve);
			})
		]));
		if (promisesResult[0] !== null) {
			duplex.destroy(promisesResult[0]);
		}
	})();

	return mergePromise(duplex, result);
};
