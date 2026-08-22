import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { ReviewDesk } from "@/components/ReviewDesk";

export default async function ReviewPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Review" action="Sign in to review changes" />
    );
  }
  return <ReviewDesk />;
}
