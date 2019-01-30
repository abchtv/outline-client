// Copyright 2019 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as dgram from 'dgram';
import * as dns from 'dns';
import * as net from 'net';
import * as socks from 'socks';

import * as util from '../www/app/util';
import * as errors from '../www/model/errors';

import {SsLocal, Tun2socks} from './processes';
import {RoutingService} from './routing';

const PROXY_ADDRESS = '127.0.0.1';
const PROXY_PORT = 1081;

const CREDENTIALS_TEST_DOMAINS = ['example.com', 'ietf.org', 'wikipedia.org'];
const REACHABILITY_TEST_TIMEOUT_MS = 10000;
const DNS_LOOKUP_TIMEOUT_MS = 10000;

const UDP_FORWARDING_TEST_TIMEOUT_MS = 5000;
const UDP_FORWARDING_TEST_RETRY_INTERVAL_MS = 1000;

// DNS request to google.com.
const DNS_REQUEST = Buffer.from([
  0, 0,                             // [0-1]   query ID
  1, 0,                             // [2-3]   flags; byte[2] = 1 for recursion desired (RD).
  0, 1,                             // [4-5]   QDCOUNT (number of queries)
  0, 0,                             // [6-7]   ANCOUNT (number of answers)
  0, 0,                             // [8-9]   NSCOUNT (number of name server records)
  0, 0,                             // [10-11] ARCOUNT (number of additional records)
  6, 103, 111, 111, 103, 108, 101,  // google
  3, 99,  111, 109,                 // com
  0,                                // null terminator of FQDN (root TLD)
  0, 1,                             // QTYPE, set to A
  0, 1                              // QCLASS, set to 1 = IN (Internet)
]);

// Coordinates routing and helper processes to establish a full-system VPN.
// Follows the Mediator pattern.
//
// TODO: test for UDP support
// TODO: restart tun2socks when UDP support changes
export class ConnectionMediator {
  private routing = new RoutingService();
  private ssLocal = new SsLocal(PROXY_PORT);
  private tun2socks = new Tun2socks(PROXY_ADDRESS, PROXY_PORT);

  // ugh horrible
  private currentId: string|undefined;

  private listener?: (status: ConnectionStatus, connectionId: string) => void;

  setListener(listener: (status: ConnectionStatus, connectionId: string) => void) {
    this.listener = listener;
  }

  private setHelperListeners(newListener?: () => void) {
    this.routing.setDisconnectionListener(newListener);
    this.ssLocal.setExitListener(newListener);
    this.tun2socks.setExitListener(newListener);
  }

  // TODO: stop if already started?
  // TODO: check reachability
  // TODO: reject with error codes
  async start(config: cordova.plugins.outline.ServerConfig, id: string) {
    console.log('starting connection helper processes...');
    this.currentId = id;

    this.setHelperListeners(this.onExitOrFailure.bind(this));

    await this.routing.start(config.host || '');
    this.tun2socks.start();
    this.ssLocal.start(config);
  }

  private onExitOrFailure() {
    console.error('one or more connection helper processes failed or exited');
    this.stop();
  }

  async stop() {
    console.log('stopping connection helper processes...');

    // Stop listening for failures: they are all about to fail when we kill them.
    this.setHelperListeners(undefined);

    await this.routing.stop();
    this.ssLocal.stop();
    this.tun2socks.stop();

    if (this.listener && this.currentId) {
      this.listener(ConnectionStatus.DISCONNECTED, this.currentId);
    }
  }
}

// Uses the OS' built-in functions, i.e. /etc/hosts, et al.:
// https://nodejs.org/dist/latest-v10.x/docs/api/dns.html#dns_dns
//
// Effectively a no-op if hostname is already an IP.
export function lookupIp(hostname: string): Promise<string> {
  return util.timeoutPromise(
      new Promise<string>((fulfill, reject) => {
        dns.lookup(hostname, 4, (e, address) => {
          if (e) {
            return reject(new errors.ServerUnreachable('could not resolve proxy server hostname'));
          }
          fulfill(address);
        });
      }),
      DNS_LOOKUP_TIMEOUT_MS, 'DNS lookup');
}

// Resolves with true iff a TCP connection can be established with the Shadowsocks server.
//
// This has the same function as ShadowsocksConnectivity.isServerReachable in
// cordova-plugin-outline.
export function isServerReachable(config: cordova.plugins.outline.ServerConfig) {
  return lookupIp(config.host || '').then((ip) => {
    return isServerReachableByIp(ip, config.port || 0);
  });
}

// As #isServerReachable but does not perform a DNS lookup.
export function isServerReachableByIp(serverIp: string, serverPort: number) {
  return util.timeoutPromise(
      new Promise<void>((fulfill, reject) => {
        const socket = new net.Socket();
        socket
            .connect(
                {host: serverIp, port: serverPort},
                () => {
                  socket.end();
                  fulfill();
                })
            .on('error', () => {
              reject(new errors.ServerUnreachable());
            });
      }),
      REACHABILITY_TEST_TIMEOUT_MS, 'Reachability check');
}

// Resolves with true iff a response can be received from a semi-randomly-chosen website through the
// Shadowsocks proxy.
//
// This has the same function as ShadowsocksConnectivity.validateServerCredentials in
// cordova-plugin-outline.
export function validateServerCredentials(proxyAddress: string, proxyIp: number) {
  return new Promise<void>((fulfill, reject) => {
    const testDomain =
        CREDENTIALS_TEST_DOMAINS[Math.floor(Math.random() * CREDENTIALS_TEST_DOMAINS.length)];
    socks.createConnection(
        {
          proxy: {ipaddress: proxyAddress, port: proxyIp, type: 5},
          target: {host: testDomain, port: 80}
        },
        (e, socket) => {
          if (e) {
            reject(new errors.InvalidServerCredentials(
                `could not connect to remote test website: ${e.message}`));
            return;
          }

          socket.write(`HEAD / HTTP/1.1\r\nHost: ${testDomain}\r\n\r\n`);

          socket.on('data', (data) => {
            if (data.toString().startsWith('HTTP/1.1')) {
              socket.end();
              fulfill();
            } else {
              socket.end();
              reject(new errors.InvalidServerCredentials(
                  `unexpected response from remote test website`));
            }
          });

          socket.on('close', () => {
            reject(new errors.InvalidServerCredentials(`could not connect to remote test website`));
          });

          // Sockets must be resumed before any data will come in, as they are paused right before
          // this callback is fired.
          socket.resume();
        });
  });
}

// Verifies that the remote server has enabled UDP forwarding by sending a DNS request through it.
export function checkUdpForwardingEnabled(proxyAddress: string, proxyIp: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    socks.createConnection(
        {
          proxy: {ipaddress: proxyAddress, port: proxyIp, type: 5, command: 'associate'},
          target: {host: '0.0.0.0', port: 0},  // Specify the actual target once we get a response.
        },
        (err, socket, info) => {
          if (err) {
            reject(new errors.RemoteUdpForwardingDisabled(`could not connect to local proxy`));
            return;
          }
          const packet = socks.createUDPFrame({host: '1.1.1.1', port: 53}, DNS_REQUEST);
          const udpSocket = dgram.createSocket('udp4');

          udpSocket.on('error', (e) => {
            reject(new errors.RemoteUdpForwardingDisabled('UDP socket failure'));
          });

          udpSocket.on('message', (msg, info) => {
            stopUdp();
            resolve(true);
          });

          // Retry sending the query every second.
          // TODO: logging here is a bit verbose
          const intervalId = setInterval(() => {
            try {
              udpSocket.send(packet, info.port, info.host, (err) => {
                if (err) {
                  console.error(`Failed to send data through UDP: ${err}`);
                }
              });
            } catch (e) {
              console.error(`Failed to send data through UDP ${e}`);
            }
          }, UDP_FORWARDING_TEST_RETRY_INTERVAL_MS);

          const stopUdp = () => {
            try {
              clearInterval(intervalId);
              udpSocket.close();
            } catch (e) {
              // Ignore; there may be multiple calls to this function.
            }
          };

          // Give up after the timeout elapses.
          setTimeout(() => {
            stopUdp();
            resolve(false);
          }, UDP_FORWARDING_TEST_TIMEOUT_MS);
        });
  });
}
