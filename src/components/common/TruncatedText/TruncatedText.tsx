// -- Framework Imports --
import { useLayoutEffect, useState } from "react";

// -- Component Imports --
import { Tooltip } from "../Tooltip/Tooltip";

/**
 * A one-line text span whose full text shows in the tooltip only while the ellipsis is cutting it. The
 * `className` must give the span the clipping (overflow hidden, nowrap, ellipsis); the width is watched,
 * so a resize that starts or stops the cut turns the tooltip on or off.
 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => setCut(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, text]);

  return (
    <Tooltip label={cut ? text : null}>
      <span ref={setNode} className={className}>
        {text}
      </span>
    </Tooltip>
  );
}
