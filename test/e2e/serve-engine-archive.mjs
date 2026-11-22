import fs from 'node:fs';
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const { file, fileName, size } = workerData;
const server = http.createServer((request, response) => {
  if (request.url !== '/' + fileName) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-length': size });
  fs.createReadStream(file).on('error', (error) => response.destroy(error)).pipe(response);
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage(`http://127.0.0.1:${server.address().port}/${fileName}`));
