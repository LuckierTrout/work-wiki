import { getPrincipal } from "@/lib/auth";
import { eventToIcalendar, listOutboxEvents } from "@/lib/integration-outbox";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return new Response("Sign in required.", { status: 401 });
  const events = (await listOutboxEvents(principal.handle)).filter(
    (event) => event.destination === "icalendar" && event.status !== "cancelled",
  );
  const todos = events.map((event) => {
    const calendar = event.receipt?.calendar ?? eventToIcalendar(event);
    return calendar
      .replace(/BEGIN:VCALENDAR\r?\nVERSION:2\.0\r?\nPRODID:[^\r\n]+\r?\n/, "")
      .replace(/END:VCALENDAR\r?\n?$/, "")
      .trim();
  });
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//work-wiki//work-wiki//EN",
    ...todos,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="workwiki-actions.ics"',
      "Cache-Control": "private, no-store",
    },
  });
}
