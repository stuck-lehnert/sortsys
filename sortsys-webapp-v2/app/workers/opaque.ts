import { attachOpaqueWorker } from "@sortsys/zerotrust/worker";
import type { OpaqueWorkerScope } from "@sortsys/zerotrust/worker";
attachOpaqueWorker(globalThis as unknown as OpaqueWorkerScope);
