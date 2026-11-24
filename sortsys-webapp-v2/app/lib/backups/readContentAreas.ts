import { arrayBatches, mapConcurrent } from "@sortsys/zerotrust";
import type {
  Collection,
  OpenedObject,
  protectedReadView,
} from "../data/protectedObjects";

export type ContentReadView = Awaited<ReturnType<typeof protectedReadView>>;

export async function forEachContentArea(
  view: ContentReadView,
  areas: readonly Collection[],
  concurrency: number,
  visit: (area: Collection) => Promise<void>,
) {
  for (const batch of arrayBatches(areas, 16)) {
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, concurrency, visit);
  }
}

export function readContentAreas(
  view: ContentReadView,
  areas: readonly Collection[],
  visit: (area: Collection, object: OpenedObject) => void | Promise<void>,
  options?: { includeTombstones?: boolean },
) {
  return forEachContentArea(view, areas, 4, async (area) => {
    for (const object of await view.read(area, options)) {
      const pending = visit(area, object);
      if (pending) await pending;
    }
  });
}
