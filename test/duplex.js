import path from 'path';
import test from 'ava';
import execa from '..';
import stream from 'stream';
import crypto from 'crypto';
import {promisify} from 'util';

const pipeline = promisify(stream.pipeline);

process.env.PATH = path.join(__dirname, 'fixtures') + path.delimiter + process.env.PATH;

function makeCollector() {
	const chunks = [];
	const writableStream = new stream.Writable({
		write(chunk, encoding, callback) {
			chunks.push(chunk);
			callback();
		},
		final(callback) {
			callback();
		}
	});
	writableStream.collect = () => Buffer.concat(chunks).toString('utf-8');
	return writableStream;
}

function makeEmptyReadableStream() {
	return new stream.Readable({
		read() {}
	});
}

test('simple pipeline', async t => {
	const duplex = execa.duplexStream('stdin');
	const collector = makeCollector();
	t.is(await pipeline(stream.Readable.from('hello, world'), duplex, collector), undefined);
	t.is(collector.collect(), 'hello, world');
});

test('command failure should result in pipeline failure', async t => {
	const duplex = execa.duplexStream('fail');
	const error = await t.throwsAsync(pipeline(makeEmptyReadableStream(), duplex, makeCollector()));
	t.is(error.exitCode, 2);
});

test('pipeline failure should kill the process', async t => {
	// TODO: how to check that process has been killed ?
	const duplex = execa.duplexStream('forever');
	const failingStream = makeEmptyReadableStream();
	failingStream.destroy(new Error('oops'));
	const {message} = await t.throwsAsync(pipeline(failingStream, duplex, makeCollector()));
	t.is(message, 'oops');
});

test('invalid arguments should result in an invalid read stream', async t => {
	const duplex = execa.duplexStream('noop', {uid: -1});
	const {failed} = await t.throwsAsync(pipeline(duplex, makeCollector()));
	t.true(failed);
});

test('invalid arguments should result in an invalid write stream', async t => {
	const duplex = execa.duplexStream('noop', {uid: -1});
	const {failed} = await t.throwsAsync(pipeline(stream.Readable.from('hello'), duplex));
	t.true(failed);
});

test('all', async t => {
	const collector = makeCollector();
	await pipeline(stream.Readable.from(Buffer.alloc(0)), execa.duplexStream('noop-132', {all: true}), collector);
	t.is(collector.collect(), '132');
});

test('we should get all output even with non-zero exit code', async t => {
	const collector = makeCollector();
	const {failed} = await t.throwsAsync(pipeline(execa.duplexStream('echo-fail'), collector));
	t.true(failed);
	t.is(collector.collect(), 'stdout\n');
});

test('timeout', async t => {
	const collector = makeCollector();
	const {failed, timedOut} = await t.throwsAsync(pipeline(execa.duplexStream('noop', {timeout: 1}), collector));
	t.is(timedOut, true);
	t.is(failed, true);
});

class MonitorMemoryUsage extends stream.Transform {
	constructor() {
		super();
		this.maxHeap = 0;
	}

	_transform(chunk, encoding, callback) {
		this.push(chunk);

		const {heapUsed} = process.memoryUsage();
		if (heapUsed > this.maxHeap) {
			this.maxHeap = heapUsed;
		}

		// Simulate slow reader
		setTimeout(() => callback(null), 1);
	}
}

class Zeroes extends stream.Readable {
	constructor(size) {
		super();
		this.remainingSize = size;
		this.buf = Buffer.alloc(65536, 0);
	}

	_read() {
		while (this.remainingSize) {
			const chunk = this.buf.slice(0, this.remainingSize);
			this.remainingSize -= chunk.length;
			if (!this.push(chunk)) {
				return;
			}
		}

		this.push(null);
	}
}

class Digest extends stream.Writable {
	constructor() {
		super();
		this.hash = crypto.createHash('sha256');
	}

	_write(chunk, encoding, callback) {
		this.hash.update(chunk);
		callback(null);
	}
}

test('using duplexStream should not use large amount of memory', async t => {
	// Generate 256 MiB worth of zeroes
	// dd if=/dev/zero of=/dev/stdout bs=$((1024*1024)) count=256 | sha256sum => a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484

	const counter = new Zeroes(64 * 1024 * 1024);
	const dgst = new Digest();
	const mem = new MonitorMemoryUsage();
	const {heapUsed} = process.memoryUsage();

	await pipeline(counter, execa.duplexStream('stdin'), mem, dgst);

	t.is(dgst.hash.digest('hex'), '3b6a07d0d404fab4e23b6d34bc6696a6a312dd92821332385e5af7c01c421351');
	t.assert((mem.maxHeap - heapUsed) / (1024 * 1024) < 10); // Allow 10 MiB
});
