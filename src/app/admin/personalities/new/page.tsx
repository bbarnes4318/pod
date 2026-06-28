import React from "react";
import HostForm from "../HostForm";
import "../personalities.css";

// Force Next.js to server-render on demand
export const dynamic = "force-dynamic";

export default function NewHostPage() {
  return (
    <div className="formContainer">
      <HostForm />
    </div>
  );
}
