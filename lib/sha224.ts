import WASMInterface, { ITypedArray, IWASMInterface, IHasher } from './WASMInterface';
import Mutex from './mutex';
import wasmJson from '../wasm/sha256.wasm.json';
import lockedCreate from './lockedCreate';

const mutex = new Mutex();
let wasmCache: IWASMInterface = null;

export function sha224(data: string | Buffer | ITypedArray): Promise<string> {
  if (wasmCache === null) {
    return lockedCreate(mutex, wasmJson, 28)
      .then((wasm) => {
        wasmCache = wasm;
        return wasmCache.calculate(data, 224);
      });
  }

  try {
    const hash = wasmCache.calculate(data, 224);
    return Promise.resolve(hash);
  } catch (err) {
    return Promise.reject(err);
  }
}

export function createSHA224(): Promise<IHasher> {
  return WASMInterface(wasmJson, 28).then((wasm) => {
    wasm.init(224);
    return {
      init: () => wasm.init(224),
      update: wasm.update,
      digest: () => wasm.digest(),
      blockSize: 64,
    };
  });
}

export default sha224;
