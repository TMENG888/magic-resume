import { createFileRoute } from "@tanstack/react-router";
import MaterialsPage from "@/app/app/dashboard/materials/page";

export const Route = createFileRoute("/app/dashboard/materials")({
  component: MaterialsPage
});
