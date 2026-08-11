type EditHeadingTarget = {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  focus: (options?: FocusOptions) => void;
};

export function revealEditHeading(
  heading: EditHeadingTarget | null
): void {
  if (!heading) {
    return;
  }

  heading.scrollIntoView({ behavior: "auto", block: "start" });
  heading.focus({ preventScroll: true });
}
