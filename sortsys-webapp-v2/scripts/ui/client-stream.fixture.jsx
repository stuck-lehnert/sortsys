import { useLayoutEffect, useState } from "react";
import { Subject } from "rxjs";
import { useClientStream } from "../../app/hooks/useClientStream";

export function ClientStreamFixture() {
  const [project, setProject] = useState("first");
  const [fixture] = useState(() => ({
    streams: { first: new Subject(), second: new Subject() },
    commits: [],
  }));

  const [value] = useClientStream(() => fixture.streams[project], [project]);

  useLayoutEffect(() => {
    fixture.commits.push({ project, value });
    window.clientStreamFixture = {
      commits: () => fixture.commits,
      subscribed: (id) => fixture.streams[id].observed,
      emit: (id, title) => fixture.streams[id].next([title, null]),
    };
  }, [fixture, project, value]);

  return (
    <section aria-label="Project stream fixture">
      <button type="button" onClick={() => setProject("second")}>
        Second project
      </button>
      <output>{value ?? "Waiting for project"}</output>
    </section>
  );
}
