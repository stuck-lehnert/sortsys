declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*?worker&inline" {
  const WorkerConstructor: {
    new (options?: { name?: string }): Worker;
  };
  export default WorkerConstructor;
}
