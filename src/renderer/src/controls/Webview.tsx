/**
 * Two implementations of embedding web content, both have drawbacks.
 * WebViewOverlay uses the electron BrowserView api, sized automatically to be positioned inside
 * a div in the DOM.
 * Browser functionality seems to be perfect, but it is rendered as a fully separate view on top
 * of the rest of Vortex and can thus not be overlayed. As such it will also not disappear until
 * unmounted (or set to an empty url).
 * Thus care has to be taken how this is utilized or it will appear broken and janky
 *
 * WebviewEmbed uses the chrome <webview> component which integrates better but doesn't seem to
 * forward all events correcty. Specifically we were not able to handle any event when clicking
 * the download button on google drive. (as of Electron 15.1.1)
 */

import { clearInterval } from "timers";

import { ipcRenderer } from "electron";
import { omit } from "lodash";
import * as React from "react";
import ReactDOM from "react-dom";

import { log } from "../util/log";
import { truthy } from "../util/util";
import { closeBrowserView, makeBrowserView, positionBrowserView, updateViewURL } from "../webview";

const RESIZE_EVENTS = ["scroll", "resize"];

export interface IWebView extends React.DetailedHTMLProps<
  React.WebViewHTMLAttributes<HTMLWebViewElement>,
  HTMLWebViewElement
> {
  src?: string;
  style?: any;
  autosize?: boolean;
  nodeintegration?: boolean;
  plugins?: boolean;
  preload?: string;
  httpreferrer?: string;
  useragent?: string;
  disablewebsecurity?: boolean;
  partition?: string;
  webpreferences?: string;
  blinkfeatures?: string;
  disableblinkfeatures?: string;
  guestinstance?: string;
}

export interface IWebviewProps {
  onLoading?: (loading: boolean) => void;
  onNewWindow?: (url: string, disposition: string) => void;
  onFullscreen?: (fullscreen: boolean) => void;
  events?: { [evtId: string]: (...args: any[]) => void };
}

interface IBrowserViewProps {
  src: string;
  events: { [name: string]: (...args: any[]) => void };
}

function reportViewError(error: unknown) {
  log("warn", "embedded browser operation failed", { error });
}

function BrowserView(props: IBrowserViewProps) {
  const viewId = React.useRef<string>();
  const container = React.useRef<HTMLDivElement>();
  const bounds = React.useRef<Electron.Rectangle>();
  const latestProps = React.useRef(props);
  latestProps.current = props;

  const updateViewBounds = React.useCallback(() => {
    if (truthy(container.current) && viewId.current !== undefined) {
      const rect = container.current.getBoundingClientRect();

      bounds.current = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };

      positionBrowserView(viewId.current, bounds.current).catch(reportViewError);
    }
  }, []);

  React.useEffect(() => {
    let wasVisible: boolean = true;
    const overlapTest = setInterval(() => {
      if (truthy(bounds.current) && viewId.current !== undefined) {
        // janky way of estimating a position that would be overlapped
        const x = bounds.current.x + bounds.current.width / 2;
        const y1 = bounds.current.y + bounds.current.height * 0.33;
        const y2 = bounds.current.y + bounds.current.height * 0.66;
        const ele1 = document.elementFromPoint(x, y1);
        const ele2 = document.elementFromPoint(x, y2);
        const isVisible = ele1 === container.current && ele2 === container.current;
        if (wasVisible !== isVisible) {
          positionBrowserView(
            viewId.current,
            isVisible ? bounds.current : { x: 0, y: 0, width: 0, height: 0 },
          ).catch(reportViewError);
          wasVisible = isVisible;
        }
      }
    }, 1000);
    return () => {
      clearInterval(overlapTest);
    };
  }, []);

  React.useEffect(() => {
    if (viewId.current !== undefined) {
      updateViewURL(viewId.current, props.src).catch(reportViewError);
    }
  }, [props.src]);

  React.useEffect(() => {
    let active = true;
    const listeners = new Map<string, (_event: Electron.IpcRendererEvent, args: string) => void>();
    const impl = async () => {
      const id = await makeBrowserView(props.src, Object.keys(props.events), {
        webPreferences: {
          // Use separate partition to isolate cookies from main window
          // This prevents external site cookies (e.g., moddb.com) from being
          // sent to CDN downloads that use signed URLs for authentication
          partition: "persist:webview",
        },
      });
      if (!active) {
        await closeBrowserView(id);
        return;
      }
      viewId.current = id;

      RESIZE_EVENTS.forEach((evtId) => {
        window.addEventListener(evtId, updateViewBounds);
      });

      Object.keys(props.events).forEach((evtId) => {
        const channel = `view-${id}-${evtId}`;
        const listener = (_evt: Electron.IpcRendererEvent, argsJSON: string) => {
          latestProps.current.events[evtId]?.(...JSON.parse(argsJSON));
        };
        listeners.set(channel, listener);
        ipcRenderer.on(channel, listener);
      });
      updateViewBounds();
      if (latestProps.current.src !== props.src) {
        await updateViewURL(id, latestProps.current.src);
      }
    };

    impl().catch(reportViewError);

    return () => {
      active = false;
      if (viewId.current !== undefined) {
        closeBrowserView(viewId.current).catch(reportViewError);
        viewId.current = undefined;
      }
      RESIZE_EVENTS.forEach((evtId) => {
        window.removeEventListener(evtId, updateViewBounds);
      });

      listeners.forEach((listener, channel) => ipcRenderer.removeListener(channel, listener));
    };
  }, []);

  return (
    <div
      ref={container}
      style={{
        width: "100%",
        height: "100%",
      }}
    />
  );
}

const emptyObject = {};

export class WebviewOverlay extends React.Component<IWebviewProps & IWebView, { src: string }> {
  constructor(props: IWebviewProps & IWebView) {
    super(props);

    this.state = {
      src: props.src,
    };
  }

  public UNSAFE_componentWillReceiveProps(newProps: IWebviewProps & IWebView) {
    if (this.props.src !== newProps.src) {
      this.setState({ src: newProps.src });
    }
  }

  public render(): JSX.Element {
    const { events } = this.props;
    return truthy(this.props.src) ? (
      <BrowserView
        src={this.state.src}
        events={{
          "did-start-loading": this.startLoad,
          "did-stop-loading": this.stopLoad,
          "console-message": this.logMessage,
          "new-window": this.newWindow,
          "enter-html-full-screen": this.enterFullscreen,
          "leave-html-full-screen": this.leaveFullscreen,
          ...(events ?? emptyObject),
        }}
      />
    ) : null;
  }

  public loadURL(newUrl: string) {
    this.setState({ src: newUrl });
  }

  private startLoad = () => {
    const { onLoading } = this.props;
    if (onLoading !== undefined) {
      onLoading(true);
    }
  };

  private stopLoad = () => {
    const { onLoading } = this.props;
    if (onLoading !== undefined) {
      onLoading(false);
    }
  };

  private newWindow = (url: string, frameName: string, disposition: string) => {
    const { onNewWindow } = this.props;
    if (onNewWindow !== undefined) {
      onNewWindow(url, disposition);
    }
  };

  private enterFullscreen = () => {
    const { onFullscreen } = this.props;

    if (onFullscreen !== undefined) {
      onFullscreen(true);
    }
  };

  private leaveFullscreen = () => {
    const { onFullscreen } = this.props;

    if (onFullscreen !== undefined) {
      onFullscreen(false);
    }
  };

  private logMessage = (level, message) => {
    if (level > 2) {
      log("info", "from embedded page", { level, message });
    }
  };
}

export class WebviewEmbed extends React.Component<IWebviewProps & IWebView, {}> {
  private mNode: HTMLWebViewElement;
  private mContentsId: number | undefined;

  private domReady = () => {
    this.mContentsId = this.mNode["getWebContentsId"]();
    ipcRenderer.send("webview-dom-ready", this.mContentsId);
  };

  private openUrl = (
    _event: Electron.IpcRendererEvent,
    id: number,
    url: string,
    disposition: string,
  ) => {
    if (id === this.mContentsId) this.props.onNewWindow?.(url, disposition);
  };

  public componentDidMount() {
    this.mNode = ReactDOM.findDOMNode(this) as HTMLWebViewElement;
    this.mNode.addEventListener("did-start-loading", this.startLoad);
    this.mNode.addEventListener("did-stop-loading", this.stopLoad);
    this.mNode.addEventListener("dom-ready", this.domReady);
    ipcRenderer.on("webview-open-url", this.openUrl);
    this.mNode.addEventListener("console-message", this.logMessage);
    // this.mNode.addEventListener('new-window', this.newWindow);
    this.mNode.addEventListener("enter-html-full-screen", this.enterFullscreen);
    this.mNode.addEventListener("leave-html-full-screen", this.leaveFullscreen);
  }

  public componentWillUnmount() {
    this.mNode.removeEventListener("dom-ready", this.domReady);
    ipcRenderer.removeListener("webview-open-url", this.openUrl);
    this.mContentsId = undefined;
    this.mNode.removeEventListener("did-start-loading", this.startLoad);
    this.mNode.removeEventListener("did-stop-loading", this.stopLoad);
    this.mNode.removeEventListener("console-message", this.logMessage);
    // this.mNode.removeEventListener('new-window', this.newWindow);
    this.mNode.removeEventListener("enter-html-full-screen", this.enterFullscreen);
    this.mNode.removeEventListener("leave-html-full-screen", this.leaveFullscreen);
  }

  public render(): JSX.Element {
    return React.createElement("webview", {
      ...omit(this.props, ["onLoading", "onNewWindow", "onFullscreen", "events"]),
      allowpopups: "true",
    });
  }

  public loadURL(newUrl: string) {
    this.mNode["loadURL"](newUrl);
  }

  private startLoad = () => {
    const { onLoading } = this.props;
    if (onLoading !== undefined) {
      onLoading(true);
    }
  };

  private stopLoad = () => {
    const { onLoading } = this.props;
    if (onLoading !== undefined) {
      onLoading(false);
    }
  };

  private newWindow = (evt) => {
    const { onNewWindow } = this.props;
    if (onNewWindow !== undefined) {
      onNewWindow(evt.url, evt.disposition);
    }
  };

  private enterFullscreen = (evt) => {
    const { onFullscreen } = this.props;

    if (onFullscreen !== undefined) {
      onFullscreen(true);
    }
  };

  private leaveFullscreen = (evt) => {
    const { onFullscreen } = this.props;

    if (onFullscreen !== undefined) {
      onFullscreen(false);
    }
  };

  private logMessage = (evt) => {
    if (evt.level > 2) {
      log("info", "from embedded page", {
        level: evt.level,
        message: evt.message,
      });
    }
  };
}

export default WebviewEmbed;
