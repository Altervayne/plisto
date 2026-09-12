// -- Framework Imports --
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

// -- Component Imports --
import { EmptyState } from "./EmptyState";
import { PrimaryButton } from "./PrimaryButton";

// -- i18n Imports --
import { useT } from "../../i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a render or lifecycle throw anywhere below it and shows a usable fallback instead of a blank
 * webview. A class because only a class can be an error boundary; the fallback is a function so it reads
 * the active locale. Restart reloads the webview, which reboots the app from a clean tree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error in the render tree", error, info);
  }

  render() {
    if (this.state.error) return <ErrorFallback message={this.state.error.message} />;
    return this.props.children;
  }
}

/** The calm centered fallback: the failure, its message so the user can report it, and the restart. */
function ErrorFallback({ message }: { message: string }) {
  const t = useT();
  return (
    <EmptyState
      tone="warn"
      title={t((d) => d.errorBoundary.title)}
      line={message || t((d) => d.errorBoundary.line)}
      action={
        <PrimaryButton onClick={() => window.location.reload()}>
          {t((d) => d.errorBoundary.restart)}
        </PrimaryButton>
      }
    />
  );
}
