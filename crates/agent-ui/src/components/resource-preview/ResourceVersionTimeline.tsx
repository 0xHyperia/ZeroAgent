type Version = { id: string; number: number; created_at: string };

/** Metadata-only history; selecting a point never changes the current head. */
export function ResourceVersionTimeline(props: {
  versions: readonly Version[];
  selected: string;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const groups = new Map<string, Version[]>();
  for (const version of props.versions) {
    const date = new Date(version.created_at).toLocaleDateString("zh-CN");
    groups.set(date, [...(groups.get(date) ?? []), version]);
  }
  return (
    <div className="za-reader-timeline" aria-busy={props.busy}>
      {[...groups].map(([date, versions]) => (
        <section key={date} aria-label={date}>
          <h4>{date === new Date().toLocaleDateString("zh-CN") ? "今天" : date}</h4>
          <ol>
            {versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className="za-reader-timeline-point"
                  data-version-id={version.id}
                  aria-label={`查看版本 v${version.number}`}
                  aria-current={version.id === props.selected ? "true" : undefined}
                  disabled={props.busy}
                  onClick={() => props.onSelect(version.id)}
                >
                  <time dateTime={version.created_at}>
                    {new Date(version.created_at).toLocaleTimeString("zh-CN", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                  <span>
                    {version.id === props.versions[0]?.id
                      ? "当前版本"
                      : version.number === 1
                        ? "已创建"
                        : `版本 ${version.number}`}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
