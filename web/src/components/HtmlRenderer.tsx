/**
 * HTML Renderer Component - Secure rendering of agent-generated HTML content.
 * 
 * Agent-generated HTML is treated as UNTRUSTED by default and rendered inside a sandboxed iframe
 * (sandbox="allow-scripts" WITHOUT allow-same-origin) to prevent access to parent window,
 * cookies, localStorage, and DOM - following multica-ai's security pattern.
 * 
 * Three trust levels:
 * - 'untrusted' (default): iframe sandbox, complete isolation - agent-generated content
 * - 'semi-trusted': DOMPurify sanitized rendering - internal tools, validated content
 * - 'trusted': Basic sanitization only - audited templates, system-generated content
 * 
 * Security model:
 * - iframe sandbox: prevents XSS, clickjacking, cookie theft, localStorage access
 * - DOMPurify: removes dangerous tags/attrs (script, iframe, onclick, onerror, etc.)
 * - CSP (server-side): second line of defense, blocks inline scripts globally
 * 
 * Usage in Chat.tsx:
 * <HtmlRenderer html={agentOutput.html} trustLevel="untrusted" />
 */
import { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";

export type TrustLevel = "untrusted" | "semi-trusted" | "trusted";

interface HtmlRendererProps {
  html: string;
  trustLevel?: TrustLevel;
  className?: string;
  style?: React.CSSProperties;
  minHeight?: number | string;
  maxHeight?: number | string;
  onMessage?: (type: string, payload: any) => void; // iframe postMessage handler
}

/**
 * DOMPurify configuration for different trust levels.
 * Conservative by default - only allow safe formatting tags.
 */
type PurifyConfig = Parameters<typeof DOMPurify.sanitize>[1];

const PURIFY_CONFIGS: Record<TrustLevel, PurifyConfig> = {
  // Untrusted: never used (iframe sandbox instead), but fallback config
  untrusted: {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "u", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img", "div", "span", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "blockquote"],
    ALLOWED_ATTR: ["href", "src", "alt", "class", "id", "style", "target", "rel", "width", "height"],
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "meta", "link", "style", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onmouseout", "onmouseenter", "onmouseleave", "onfocus", "onblur", "onchange", "onsubmit", "onkeydown", "onkeyup", "onkeypress"],
    ADD_ATTR: ["target"], // allow target="_blank"
    ALLOW_DATA_ATTR: false,
    ADD_TAGS: [], // no custom tags
  },
  
  // Semi-trusted: broader tag set, still forbid dangerous
  "semi-trusted": {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "u", "s", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img", "div", "span", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "blockquote", "hr", "dl", "dt", "dd", "figure", "figcaption", "video", "audio", "source"],
    ALLOWED_ATTR: ["href", "src", "alt", "class", "id", "style", "target", "rel", "width", "height", "controls", "autoplay", "loop", "muted", "poster", "preload"],
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "meta", "link", "style", "base", "noscript"],
    FORBID_ATTR: ["on*"], // forbid all event handlers (regex pattern)
    ADD_ATTR: ["target", "rel"],
    ALLOW_DATA_ATTR: false,
  },
  
  // Trusted: minimal sanitization, only remove script and event handlers
  trusted: {
    FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "applet"],
    FORBID_ATTR: ["on*"], // forbid all event handlers
    ALLOW_DATA_ATTR: false,
  },
};

/**
 * Sandbox iframe HTML renderer - complete isolation from parent window.
 * Used for agent-generated HTML (untrusted) to prevent XSS and data theft.
 * 
 * Security: sandbox="allow-scripts" WITHOUT allow-same-origin
 * - allow-scripts: HTML can run its own scripts (for interactive charts, animations)
 * - NO allow-same-origin: prevents access to parent.document, cookies, localStorage
 * - Result: HTML renders and runs scripts, but cannot interact with the parent app
 * 
 * Reference: multica-ai's iframe-fragment-nav.ts pattern
 */
function IframeRenderer({ html, className, style, minHeight = 400, maxHeight, onMessage }: HtmlRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(typeof minHeight === "number" ? minHeight : 400);
  
  // Auto-resize iframe to fit content (optional, requires postMessage from iframe)
  useEffect(() => {
    if (!onMessage) return;
    
    const handleMessage = (e: MessageEvent) => {
      // Only accept messages from this iframe
      if (e.source === iframeRef.current?.contentWindow) {
        // Handle resize messages
        if (e.data.type === "resize" && e.data.height) {
          setHeight(Math.max(typeof minHeight === "number" ? minHeight : 400, e.data.height));
        }
        // Forward custom messages to parent handler
        onMessage?.(e.data.type, e.data.payload);
      }
    };
    
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onMessage, minHeight]);
  
  // Inject resize observer script into HTML (for auto-height)
  const htmlWithResize = html + `
    <script>
      // Auto-resize observer - notify parent of content height changes
      (function() {
        const sendHeight = () => {
          window.parent.postMessage({
            type: 'resize',
            height: document.body.scrollHeight
          }, '*');
        };
        
        // Send initial height
        sendHeight();
        
        // Observe DOM changes
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(sendHeight).observe(document.body);
        } else {
          // Fallback: poll every 500ms
          setInterval(sendHeight, 500);
        }
      })();
    </script>
  `;
  
  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts" // Critical: NO allow-same-origin
      srcDoc={htmlWithResize}
      className={className}
      style={{
        ...style,
        border: "none",
        width: "100%",
        minHeight: typeof minHeight === "number" ? `${minHeight}px` : minHeight,
        maxHeight: maxHeight ? (typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight) : undefined,
        height: `${height}px`,
        overflow: "auto",
      }}
      title="Agent HTML Output"
      loading="lazy"
    />
  );
}

/**
 * DOMPurify HTML renderer - sanitized rendering within React component.
 * Used for semi-trusted and trusted content that can render in the main DOM.
 */
function DomRenderer({ html, trustLevel, className, style }: HtmlRendererProps) {
  const config = PURIFY_CONFIGS[trustLevel || "untrusted"];
  const clean = DOMPurify.sanitize(html, config);
  
  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

/**
 * Main HTML renderer component - chooses strategy based on trustLevel.
 * 
 * Default: untrusted → iframe sandbox (agent-generated content)
 * Optional: semi-trusted/trusted → DOMPurify (validated content)
 */
export function HtmlRenderer(props: HtmlRendererProps) {
  const { html, trustLevel = "untrusted" } = props;
  
  // Empty check
  if (!html || html.trim() === "") {
    return null;
  }
  
  // Strategy selection
  if (trustLevel === "untrusted") {
    return <IframeRenderer {...props} />;
  } else {
    return <DomRenderer {...props} />;
  }
}

/**
 * Utility: Check if content contains HTML tags.
 * Used to decide whether to use HtmlRenderer vs plain text rendering.
 */
export function isHtmlContent(content: string): boolean {
  // Quick heuristic: look for common HTML tags
  const htmlPattern = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/;
  return htmlPattern.test(content);
}

/**
 * Utility: Extract HTML from mixed markdown+HTML content.
 * If content is pure markdown, returns null.
 * If content contains HTML blocks, extracts and returns the HTML portion.
 */
export function extractHtmlFromMarkdown(content: string): string | null {
  // Look for HTML blocks in markdown (lines starting with <)
  const lines = content.split("\n");
  const htmlLines: string[] = [];
  let inHtmlBlock = false;
  
  for (const line of lines) {
    // HTML block starts with <tag
    if (line.trim().startsWith("<")) {
      inHtmlBlock = true;
    }
    // HTML block ends at blank line or markdown content
    if (inHtmlBlock && line.trim() === "") {
      inHtmlBlock = false;
    }
    
    if (inHtmlBlock) {
      htmlLines.push(line);
    }
  }
  
  const html = htmlLines.join("\n");
  return html.trim() !== "" ? html : null;
}
