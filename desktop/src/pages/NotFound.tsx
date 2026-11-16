import { Link } from "@tanstack/react-router";
import { Page } from "../ui/Page";

export function NotFoundPage() {
  return (
    <Page heading="Page not found">
      <p className="facts">
        Nothing is at this address. The link that brought you here may be out of date.
      </p>
      <p>
        <Link to="/" className="link">
          Go to Home
        </Link>
      </p>
    </Page>
  );
}
