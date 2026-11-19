import type {
  Collection,
  OpenedObject,
  protectedReadView,
} from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";

export type ContentReadView = Awaited<ReturnType<typeof protectedReadView>>;

export async function readContentAreas(
  view: ContentReadView,
  areas: readonly Collection[],
  visit: (area: Collection, object: OpenedObject) => void,
) {
  for (let offset = 0; offset < areas.length; offset += 16) {
    const batch = areas.slice(offset, offset + 16);
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, 4, async (area) => {
      for (const object of await view.read(area)) visit(area, object);
    });
  }
}
