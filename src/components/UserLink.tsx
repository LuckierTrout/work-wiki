/**
 * A handle rendered as `@handle`, as plain text. The public profile page
 * (`/u/<handle>`) is retired, so a handle is a label rather than a link — for
 * humans and agents alike. Use for plain-text byline/author sites that don't
 * use the {@link Mark} chip (comments, revisions).
 */
export function UserLink({
  handle,
  className,
}: {
  handle: string;
  className?: string;
}) {
  return <span className={className}>@{handle}</span>;
}
