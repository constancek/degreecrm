import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";

/** Techs start on their Today screen; the owner on the pipeline. */
export default async function Home() {
  const user = await requireUser();
  redirect(user.role === "tech" ? "/my-day" : "/pipeline");
}
