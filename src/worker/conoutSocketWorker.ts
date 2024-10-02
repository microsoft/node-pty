/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 */

import { parentPort, workerData } from 'worker_threads';
import { Socket, createServer } from 'net';
import { ConoutWorkerMessage, IWorkerData, getWorkerPipeName } from '../shared/conout';

const { conoutPipeName, conoutFD } = workerData as IWorkerData;
const conoutSocket = new Socket(conoutFD ? {
  fd: conoutFD,
  readable: true,
  writable: false
} : undefined);
conoutSocket.setEncoding('utf8');
const onConnect = () => {
  const server = createServer(workerSocket => {
    conoutSocket.pipe(workerSocket);
  });
  server.listen(getWorkerPipeName(conoutPipeName));

  if (!parentPort) {
    throw new Error('worker_threads parentPort is null');
  }
  parentPort.postMessage(ConoutWorkerMessage.READY);
};
if (conoutFD) {
  onConnect();
} else {
  conoutSocket.connect(conoutPipeName, onConnect);
}
