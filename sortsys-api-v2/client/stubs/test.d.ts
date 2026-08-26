type MockClient = {
  query(path: string, input: unknown): Promise<unknown>;
  mutation(path: string, input: unknown): Promise<unknown>;
};

export declare namespace test {
  export type TestServerCallbackProps = {
    host: string;
    fetch: (...args: any[]) => Promise<any>;
    createClient: (...args: any[]) => MockClient;
  };

  export type TestSeed = {
    [key: string]: any;
    users: any[];
    projects: any[];
    tools: any[];
    productVendors: any[];
    productPriceRecords: any[];
    productDeliveryNotes: any[];
    productDeliveryRecords: any[];
    toolTrackings: any[];
    projectDeployments: any[];
    regieReports: any[];
    workHours: any[];
    contacts: any[];
    customers: any[];
    adminUser: any;
    roleUser: any;
    noRolesUser: any;
  };

  export type TestDatasourceCallbackProps = {
    tenant: string;
    seed: TestSeed;
  };

  export type TestServerCallback<T = any> = (props: TestServerCallbackProps) => T;
  export type TestDatasourceCallback<T = any> = (props: TestDatasourceCallbackProps) => T;

  export const create: (...args: any[]) => any;
  export const expect: any;

  export function assert(v: any): void;
  export function assertOk(res: any): void;
  export function assertNotOk(res: any): void;
  export function assertSuccess(res: any): Promise<void>;

  export function expectError<T = any>(fn: () => Promise<T>): Promise<any>;
  export function expectHttpErr(status: any, fn: () => Promise<any>): Promise<any>;

  export function useServer<T = any>(callback: TestServerCallback<T>): Promise<Awaited<T>>;
  export function rpcHandler(name: string, callback: TestServerCallback<any>, options?: { timeout?: number }): void;

  export function useDatasource<T = any>(callback: TestDatasourceCallback<T>): Promise<Awaited<T>>;
  export function useLiveDatasource<T = any>(callback: TestDatasourceCallback<T>): Promise<Awaited<T>>;

  export function loginTestUsers(...args: any[]): Promise<{
    adminToken: string;
    noRolesToken: string;
    roleToken: string | null;
    roleUser: any;
  }>;

  export function createAdminToken(...args: any[]): Promise<string>;

  export function pickSearchLetter<T>(items: T[], selector: (entry: T) => string): string;
}
