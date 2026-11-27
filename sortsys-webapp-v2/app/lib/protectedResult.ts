import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";

export async function required<T>(
  request: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [result, error] = await request;

  if (error) throw error;
  if (result === null) throw new InvalidProtectedData();

  return result;
}
