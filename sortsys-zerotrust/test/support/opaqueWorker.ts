import { attachOpaqueWorker } from "../../src/opaqueWorker";
import type { OpaqueWorkerScope } from "../../src/opaqueWorker";
attachOpaqueWorker(globalThis as unknown as OpaqueWorkerScope);
