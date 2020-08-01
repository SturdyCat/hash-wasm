import { getUInt8Buffer, IDataType, writeHexToUInt8 } from './util';
import { createBLAKE2b } from './blake2b';
import WASMInterface, { IHasher } from './WASMInterface';
import wasmJson from '../wasm/argon2.wasm.json';

interface IArgon2Options {
  password: IDataType;
  salt: IDataType;
  iterations?: number;
  parallelism?: number;
  memorySize?: number;
  hashLength?: number;
  hashType?: 'i' | 'd' | 'id';
}

const uint32View = new DataView(new ArrayBuffer(4));
function int32LE(x: number): Uint8Array {
  uint32View.setInt32(0, x, true);
  return new Uint8Array(uint32View.buffer);
}

async function hashFunc(blake512: IHasher, buf: Uint8Array, len: number): Promise<Uint8Array> {
  if (len <= 64) {
    const blake = await createBLAKE2b(len * 8);
    blake.update(int32LE(len));
    blake.update(buf);
    const res = new Uint8Array(len);
    writeHexToUInt8(res, blake.digest());
    return res;
  }

  const r = Math.ceil(len / 32) - 2;
  const ret = new Uint8Array(len);

  blake512.init();
  blake512.update(int32LE(len));
  blake512.update(buf);
  const vp = new Uint8Array(64);
  writeHexToUInt8(vp, blake512.digest());
  ret.set(vp.subarray(0, 32), 0);

  for (let i = 1; i < r; i++) {
    blake512.init();
    blake512.update(vp);
    writeHexToUInt8(vp, blake512.digest());
    ret.set(vp.subarray(0, 32), i * 32);
  }

  const partialBytesNeeded = len - 32 * r;

  let blakeSmall;
  if (partialBytesNeeded === 64) {
    blakeSmall = blake512;
    blakeSmall.init();
  } else {
    blakeSmall = await createBLAKE2b(partialBytesNeeded * 8);
  }

  blakeSmall.update(vp);
  writeHexToUInt8(vp, blakeSmall.digest());
  ret.set(vp, r * 32);

  return new Uint8Array(ret);
}

function getHashType(type: IArgon2Options['hashType']): number {
  switch (type) {
    case 'd':
      return 0;
    case 'i':
      return 1;
    case 'id':
      return 2;
    default:
      throw new Error('Invalid type!');
  }
}

async function argon2Internal(options: IArgon2Options): Promise<string> {
  const { parallelism, iterations, hashLength } = options;
  const password = getUInt8Buffer(options.password);
  const salt = getUInt8Buffer(options.salt);
  const version = 0x13;
  const hashType = getHashType(options.hashType);
  const { memorySize } = options; // in KB

  const [argon2Interface, blake512] = await Promise.all([
    WASMInterface(wasmJson, 1024),
    createBLAKE2b(512),
  ]);
  // last block is for storing the init vector
  argon2Interface.setMemorySize(memorySize * 1024 + 1024);

  const initVector = new Uint8Array(24);
  const initVectorView = new DataView(initVector.buffer);
  initVectorView.setInt32(0, parallelism, true);
  initVectorView.setInt32(4, hashLength, true);
  initVectorView.setInt32(8, memorySize, true);
  initVectorView.setInt32(12, iterations, true);
  initVectorView.setInt32(16, version, true);
  initVectorView.setInt32(20, hashType, true);
  argon2Interface.writeMemory(initVector, memorySize * 1024);

  blake512.init();
  blake512.update(initVector);
  blake512.update(int32LE(password.length));
  blake512.update(password);
  blake512.update(int32LE(salt.length));
  blake512.update(salt);
  blake512.update(int32LE(0)); // key length + key
  blake512.update(int32LE(0)); // associatedData length + associatedData

  const segments = Math.floor(memorySize / (parallelism * 4)); // length of each lane
  const lanes = segments * 4;

  const param = new Uint8Array(72);
  const H0 = blake512.digest();
  writeHexToUInt8(param, H0);
  // console.log('H0', H0);

  for (let lane = 0; lane < parallelism; lane++) {
    param.set(int32LE(0), 64);
    param.set(int32LE(lane), 68);

    let position = lane * lanes;
    let chunk = await hashFunc(blake512, param, 1024);
    // console.log('chunk', position, Buffer.from(chunk).toString('hex'));
    argon2Interface.writeMemory(chunk, position * 1024);

    position += 1;
    param.set(int32LE(1), 64);
    chunk = await hashFunc(blake512, param, 1024);
    argon2Interface.writeMemory(chunk, position * 1024);
    // console.log('chunk', position, Buffer.from(chunk).toString('hex'));
  }

  const C = new Uint8Array(1024);
  writeHexToUInt8(C, argon2Interface.calculate(new Uint8Array([]), memorySize));
  // console.log('C', Buffer.from(C).toString('hex'));

  const res = await hashFunc(blake512, C, hashLength);

  const responseStr = Buffer.from(res.buffer, res.byteOffset, res.byteLength).toString('hex');
  return Promise.resolve(responseStr);
}

const validateOptions = (options: IArgon2Options) => {
  if (!options || typeof options !== 'object') {
    throw new Error('Invalid options parameter. It requires an object.');
  }

  if (!options.password) {
    throw new Error('Password must be specified');
  }

  options.password = getUInt8Buffer(options.password);
  if (options.password.length < 1) {
    throw new Error('Password must be specified');
  }

  if (!options.salt) {
    throw new Error('Salt must be specified');
  }

  options.salt = getUInt8Buffer(options.salt);
  if (options.salt.length < 8) {
    throw new Error('Salt should be at least 8 bytes long');
  }

  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('Iterations should be a positive number');
  }

  if (!Number.isInteger(options.parallelism) || options.parallelism < 1) {
    throw new Error('Parallelism should be a positive number');
  }

  if (!Number.isInteger(options.hashLength) || options.hashLength < 4) {
    throw new Error('Hash length should be at least 4 bytes.');
  }

  if (!Number.isInteger(options.memorySize)) {
    throw new Error('Memory size should be specified.');
  }

  if (options.memorySize < 8 * options.parallelism) {
    throw new Error('Memory size should be at least 8 * parallelism.');
  }

  if (!['i', 'd', 'id'].includes(options.hashType)) {
    throw new Error(`Insupported hash type ${options.hashType}. Valid values: ['i', 'd', 'id']`);
  }
};

export const argon2 = async (options: IArgon2Options): Promise<string> => {
  validateOptions(options);

  return argon2Internal(options);
};

export default argon2;