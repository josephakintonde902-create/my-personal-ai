"use client";

import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkCitations, SOURCE_LINK_PREFIX, sourceLabel } from "@/lib/ai/tutor/citations";
import type { TutorSource } from "@/lib/ai/tutor/types";

type Props = { content: string; sources: TutorSource[] };

// Renders one of Ari's answers. react-markdown builds React elements from the
// Markdown and ignores raw HTML, so nothing the model writes can inject
// markup or scripts. Images are dropped as well: an answer has no reason to
// make the browser load something from another site.
export const TutorMarkdown = memo(function TutorMarkdown({ content, sources }: Props) {
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith(SOURCE_LINK_PREFIX)) {
        const source = sources.find((item) => item.n === Number(href.slice(SOURCE_LINK_PREFIX.length)));
        return (
          <sup className="tutor-cite" title={source ? sourceLabel(source) : undefined}>
            <span className="visually-hidden">Source </span>{children}
          </sup>
        );
      }
      return <a href={href} rel="noopener noreferrer nofollow" target="_blank">{children}</a>;
    },
    // Wide tables scroll inside the message instead of stretching the page.
    table({ children }) {
      return <div className="tutor-table-wrap"><table>{children}</table></div>;
    },
  };

  return (
    <div className="tutor-markdown">
      <Markdown components={components} disallowedElements={["img"]} remarkPlugins={[remarkGfm]}>
        {linkCitations(content, sources)}
      </Markdown>
    </div>
  );
});
