function classes(...tokens: Array<string | false | null | undefined>) {
  return tokens.filter(Boolean).join(" ");
}

type PrimitiveOptions = {
  class?: string;
  nowrap?: boolean;
  light?: boolean;
};

export const nowrap = (opts?: { class?: string }) => classes(
  "whitespace-nowrap overflow-hidden text-ellipsis",
  opts?.class,
);

export const heading = (opts?: PrimitiveOptions) => classes(
  "tracking-tight font-semibold",
  opts?.nowrap !== false && nowrap(),
  opts?.light && "opacity-75",
  opts?.class,
);

export const h1 = (opts?: PrimitiveOptions) => heading({ ...opts, class: classes("text-3xl", opts?.class) });
export const h2 = (opts?: PrimitiveOptions) => heading({ ...opts, class: classes("text-2xl", opts?.class) });
export const h3 = (opts?: PrimitiveOptions) => heading({ ...opts, class: classes("text-xl", opts?.class) });
export const h4 = (opts?: PrimitiveOptions) => heading({ ...opts, class: classes("text-lg", opts?.class) });
export const h5 = (opts?: PrimitiveOptions) => heading({ ...opts, class: classes("text-base", opts?.class) });

export const text = (opts?: PrimitiveOptions) => classes(
  "tracking-tight",
  opts?.nowrap && nowrap(),
  opts?.light && "opacity-75",
  opts?.class,
);
