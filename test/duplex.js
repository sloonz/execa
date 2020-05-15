import path from 'path';
import test from 'ava';
import execa from '..';
import stream from 'stream';
import crypto from 'crypto';
import {promisify} from 'util';

const pipeline = promisify(stream.pipeline);

process.env.PATH = path.join(__dirname, 'fixtures') + path.delimiter + process.env.PATH;

function makeCollector() {
	const w = new stream.Writable({
		write(chunk, encoding, cb) {
			w.chunks.push(chunk);
			cb();
		},
		final(cb) {
			cb();
		}
	});
	w.chunks = [];
	return w;
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
	t.is(Buffer.concat(collector.chunks).toString('utf-8'), 'hello, world');
	const res = await duplex;
	t.is(res.exitCode, 0);
});

test('command failure should result in pipeline failure', async t => {
	const duplex = execa.duplexStream('fail');
	const err = await t.throwsAsync(pipeline(makeEmptyReadableStream(), duplex, makeCollector()));
	t.is(err.exitCode, 2);
});

test('pipeline failure should kill the process', async t => {
	const duplex = execa.duplexStream('forever');
	const failingStream = makeEmptyReadableStream();
	failingStream.destroy(new Error('oops'));
	const {message} = await t.throwsAsync(pipeline(failingStream, duplex, makeCollector()));
	t.is(message, 'oops');
	const err = await t.throwsAsync(duplex);
	t.is(err.isCanceled, true);
	t.is(err.killed, true);
	t.is(err.failed, true);
	t.is(err.signal, 'SIGTERM');
});

test('invalid arguments should result in an invalid read stream', async t => {
	const duplex = execa.duplexStream(null);
	duplex.catch(() => {});
	const err = await t.throwsAsync(pipeline(duplex, makeCollector()));
	t.is(err.code, 'ERR_INVALID_ARG_TYPE');
});

test('invalid arguments should result in an invalid write stream', async t => {
	const duplex = execa.duplexStream(null);
	duplex.catch(() => {});
	const err = await t.throwsAsync(pipeline(stream.Readable.from('hello'), duplex));
	t.is(err.code, 'ERR_INVALID_ARG_TYPE');
});

test('all', async t => {
	const collector = makeCollector();
	await pipeline(stream.Readable.from(Buffer.alloc(0)), execa.duplexStream('noop-132', {all: true}), collector);
	t.is(Buffer.concat(collector.chunks).toString('utf-8'), '132');
});

class MonitorMemoryUsage extends stream.Transform {
	constructor() {
		super();
		this.maxHeap = 0;
	}

	_transform(chunk, encoding, cb) {
		this.push(chunk);

		const {heapUsed} = process.memoryUsage();
		if (heapUsed > this.maxHeap) {
			this.maxHeap = heapUsed;
		}

		// Simulate slow reader
		setTimeout(() => cb(null), 1);
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

	_write(chunk, encoding, cb) {
		this.hash.update(chunk);
		cb(null);
	}
}

test('using duplexStream should not use large amount of memory', async t => {
	// Generate 256 MiB worth of zeroes
	// dd if=/dev/zero of=/dev/stdout bs=$((1024*1024)) count=256 | sha256sum => a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484

	const counter = new Zeroes(256 * 1024 * 1024);
	const dgst = new Digest();
	const mem = new MonitorMemoryUsage();
	const {heapUsed} = process.memoryUsage();

	await pipeline(counter, execa.duplexStream('stdin'), mem, dgst);

	t.is(dgst.hash.digest('hex'), 'a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484');
	t.assert((mem.maxHeap - heapUsed) / (1024 * 1024) < 10); // Allow 10 MiB
});
