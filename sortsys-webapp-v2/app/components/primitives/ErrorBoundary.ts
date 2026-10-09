import { Component, type ErrorInfo, type ReactNode } from "react";

export type ErrorBoundaryProps = {
  children: ReactNode;
  fallbackRender: (props: {
    error: unknown;
    resetErrorBoundary: () => void;
  }) => ReactNode;
  onError?: (error: unknown, info: ErrorInfo) => void;
  resetKeys?: readonly unknown[];
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: unknown;
};

function initialState(): ErrorBoundaryState {
  return { hasError: false, error: undefined };
}

function resetKeysChanged(previous: readonly unknown[] = [], next: readonly unknown[] = []) {
  return previous.length !== next.length
    || previous.some((key, index) => !Object.is(key, next[index]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = initialState();

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps, previousState: ErrorBoundaryState) {
    if (this.state.hasError && previousState.hasError
      && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.resetErrorBoundary();
    }
  }

  resetErrorBoundary = () => {
    if (this.state.hasError) this.setState(initialState());
  };

  render(): ReactNode {
    return this.state.hasError
      ? this.props.fallbackRender({
        error: this.state.error,
        resetErrorBoundary: this.resetErrorBoundary,
      })
      : this.props.children;
  }
}
