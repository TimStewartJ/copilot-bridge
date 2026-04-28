import { useEffect, useId, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

type SkeletonSize = number | string;
type SkeletonShape = "rounded" | "pill" | "circle" | "square";
type SkeletonTextWidth = number | string;

const shapeClasses: Record<SkeletonShape, string> = {
  rounded: "rounded-md",
  pill: "rounded-full",
  circle: "rounded-full aspect-square",
  square: "rounded-sm",
};

const textWidthPatterns: Record<"default" | "title" | "paragraph", SkeletonTextWidth[]> = {
  default: ["100%", "88%", "72%"],
  title: ["60%", "44%"],
  paragraph: ["100%", "96%", "82%", "66%"],
};

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function toSize(value: SkeletonSize | undefined) {
  return typeof value === "number" ? `${value}px` : value;
}

function widthForLine(widths: SkeletonTextWidth[], index: number) {
  return widths[index % widths.length] ?? "100%";
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  shape?: SkeletonShape;
  width?: SkeletonSize;
  height?: SkeletonSize;
}

export function Skeleton({
  shape = "rounded",
  width,
  height,
  className,
  style,
  ...props
}: SkeletonProps) {
  const sizeStyle: CSSProperties = {
    ...style,
    width: toSize(width) ?? style?.width,
    height: toSize(height) ?? style?.height,
  };

  return (
    <div
      {...props}
      aria-hidden="true"
      className={classes(
        "bg-bg-hover/80 border border-border/50 opacity-80 animate-pulse motion-reduce:animate-none motion-reduce:opacity-100",
        shapeClasses[shape],
        className,
      )}
      style={sizeStyle}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  widths?: SkeletonTextWidth[] | keyof typeof textWidthPatterns;
  className?: string;
  lineClassName?: string;
}

export function SkeletonText({
  lines = 3,
  widths = "default",
  className,
  lineClassName,
}: SkeletonTextProps) {
  const lineWidths = Array.isArray(widths) ? widths : textWidthPatterns[widths];

  return (
    <div className={classes("space-y-2", className)}>
      {Array.from({ length: Math.max(0, lines) }, (_, index) => (
        <Skeleton
          key={index}
          height={10}
          width={widthForLine(lineWidths, index)}
          shape="pill"
          className={lineClassName}
        />
      ))}
    </div>
  );
}

export interface SkeletonRowProps {
  leading?: boolean | "circle" | "square";
  twoLine?: boolean;
  className?: string;
}

export function SkeletonRow({ leading = true, twoLine = true, className }: SkeletonRowProps) {
  const leadingShape = leading === "square" ? "rounded" : "circle";

  return (
    <div className={classes("flex items-center gap-3 rounded-md p-3", className)}>
      {leading && <Skeleton shape={leadingShape} width={32} height={32} className="shrink-0" />}
      <div className="min-w-0 flex-1">
        <SkeletonText
          lines={twoLine ? 2 : 1}
          widths={twoLine ? ["70%", "44%"] : ["76%"]}
        />
      </div>
    </div>
  );
}

export interface SkeletonCardProps {
  children?: ReactNode;
  className?: string;
}

export function SkeletonCard({ children, className }: SkeletonCardProps) {
  return (
    <div
      aria-hidden="true"
      className={classes("rounded-lg border border-border bg-bg-surface p-4", className)}
    >
      {children ?? <SkeletonText lines={4} widths="paragraph" />}
    </div>
  );
}

export interface LoadingSkeletonRegionProps {
  isLoading: boolean;
  label: string;
  children: ReactNode;
  className?: string;
  delayMs?: number;
}

export function LoadingSkeletonRegion({
  isLoading,
  label,
  children,
  className,
  delayMs = 0,
}: LoadingSkeletonRegionProps) {
  const statusId = useId();
  const [isVisible, setIsVisible] = useState(() => isLoading && delayMs <= 0);

  useEffect(() => {
    if (!isLoading) {
      setIsVisible(false);
      return;
    }

    if (delayMs <= 0) {
      setIsVisible(true);
      return;
    }

    setIsVisible(false);
    const timeout = setTimeout(() => setIsVisible(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, isLoading]);

  if (!isLoading || !isVisible) {
    return null;
  }

  return (
    <div aria-busy="true" aria-describedby={statusId} className={className}>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      {children}
    </div>
  );
}
