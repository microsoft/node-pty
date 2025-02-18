/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */

import { parentPort, workerData } from 'worker_threads';
import { Socket, createServer } from 'net';
import * as fs from 'fs';
import { ConoutWorkerMessage, IWorkerData, getWorkerPipeName } from '../shared/conout';

const conoutPipeName = (workerData as IWorkerData).conoutPipeName;
const outSocketFD = fs.openSync(conoutPipeName, 'r');
const conoutSocket = new Socket({
  fd: outSocketFD,
  readable: true
});
conoutSocket.setEncoding('utf8');
const server = createServer(workerSocket => {
  conoutSocket.pipe(workerSocket);
});
server.listen(getWorkerPipeName(conoutPipeName));

if (!parentPort) {
  throw new Error('worker_threads parentPort is null');
}
parentPort.postMessage(ConoutWorkerMessage.READY);
