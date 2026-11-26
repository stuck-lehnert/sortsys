declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*?worker" {
  const WorkerConstructor: {
    new (options?: { name?: string }): Worker;
  };
  export default WorkerConstructor;
}
