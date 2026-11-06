import React from 'react';

export function MessageIcon({ bold, color }) {
  var c = color || "#171717";
  if (bold) {
    return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
      React.createElement("path", {d:"M17 2H7C4.24 2 2 4.23 2 6.98V12.96V13.96C2 16.71 4.24 18.94 7 18.94H8.5C8.77 18.94 9.13 19.12 9.3 19.34L10.8 21.33C11.46 22.21 12.54 22.21 13.2 21.33L14.7 19.34C14.89 19.09 15.19 18.94 15.5 18.94H17C19.76 18.94 22 16.71 22 13.96V6.98C22 4.23 19.76 2 17 2ZM13 13.75H7C6.59 13.75 6.25 13.41 6.25 13C6.25 12.59 6.59 12.25 7 12.25H13C13.41 12.25 13.75 12.59 13.75 13C13.75 13.41 13.41 13.75 13 13.75ZM17 8.75H7C6.59 8.75 6.25 8.41 6.25 8C6.25 7.59 6.59 7.25 7 7.25H17C17.41 7.25 17.75 7.59 17.75 8C17.75 8.41 17.41 8.75 17 8.75Z",fill:c})
    );
  }
  return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
    React.createElement("path", {d:"M8.5 19H8C4 19 2 18 2 13V8C2 4 4 2 8 2H16C20 2 22 4 22 8V13C22 17 20 19 16 19H15.5C15.19 19 14.89 19.15 14.7 19.4L13.2 21.4C12.54 22.28 11.46 22.28 10.8 21.4L9.3 19.4C9.14 19.18 8.77 19 8.5 19Z",stroke:c,strokeWidth:"1.5",strokeMiterlimit:"10",strokeLinecap:"round",strokeLinejoin:"round"}),
    React.createElement("path", {d:"M7 8H17",stroke:c,strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),
    React.createElement("path", {d:"M7 13H13",stroke:c,strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})
  );
}

export function DiscoverIcon({ bold, color }) {
  var c = color || "#171717";

  if (bold) {
    return React.createElement("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none" },
      React.createElement("path", {
        d: "M10.9983 1.98999C6.02828 1.98999 1.98828 6.02999 1.98828 11C1.98828 15.97 6.02828 20.01 10.9983 20.01C15.9683 20.01 20.0083 15.97 20.0083 11C20.0083 6.02999 15.9683 1.98999 10.9983 1.98999ZM14.1783 11.56C13.6183 13.34 11.6683 14.31 10.9983 14.31C10.3083 14.31 8.39828 13.38 7.81828 11.56C7.43828 10.37 7.86828 8.81999 9.22828 8.38999C9.84828 8.18999 10.5083 8.30999 10.9983 8.67999C11.4783 8.30999 12.1483 8.18999 12.7783 8.38999C14.1283 8.82999 14.5583 10.38 14.1783 11.56Z",
        fill: c
      }),
      React.createElement("path", {
        d: "M21.992 18.95C21.662 18.34 20.962 18 20.022 18C19.312 18 18.702 18.29 18.342 18.79C17.982 19.29 17.902 19.96 18.122 20.63C18.552 21.93 19.302 22.22 19.712 22.27C19.772 22.28 19.832 22.28 19.902 22.28C20.342 22.28 21.022 22.09 21.682 21.1C22.212 20.33 22.312 19.56 21.992 18.95Z",
        fill: c
      })
    );
  }

  return React.createElement("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none" },
    React.createElement("path", {
      d: "M10.9983 1.98999C6.02828 1.98999 1.98828 6.02999 1.98828 11C1.98828 15.97 6.02828 20.01 10.9983 20.01C15.9683 20.01 20.0083 15.97 20.0083 11C20.0083 6.02999 15.9683 1.98999 10.9983 1.98999ZM14.1783 11.56C13.6183 13.34 11.6683 14.31 10.9983 14.31C10.3083 14.31 8.39828 13.38 7.81828 11.56C7.43828 10.37 7.86828 8.81999 9.22828 8.38999C9.84828 8.18999 10.5083 8.30999 10.9983 8.67999C11.4783 8.30999 12.1483 8.18999 12.7783 8.38999C14.1283 8.82999 14.5583 10.38 14.1783 11.56Z",
      stroke: c, strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", fill: "none"
    }),
    React.createElement("path", {
      d: "M21.992 18.95C21.662 18.34 20.962 18 20.022 18C19.312 18 18.702 18.29 18.342 18.79C17.982 19.29 17.902 19.96 18.122 20.63C18.552 21.93 19.302 22.22 19.712 22.27C19.772 22.28 19.832 22.28 19.902 22.28C20.342 22.28 21.022 22.09 21.682 21.1C22.212 20.33 22.312 19.56 21.992 18.95Z",
      stroke: c, strokeWidth: "1.55", strokeLinecap: "round", strokeLinejoin: "round", fill: "none", transform: "translate(0.9 0.6)"
    })
  );
}

export function CalendarIcon({ bold, color }) {
  var c = color || "#171717";
  if (bold) {
    return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
      React.createElement("path", {d:"M16.75 3.56V2C16.75 1.59 16.41 1.25 16 1.25C15.59 1.25 15.25 1.59 15.25 2V3.5H8.75V2C8.75 1.59 8.41 1.25 8 1.25C7.59 1.25 7.25 1.59 7.25 2V3.56C4.55 3.81 3.24 5.42 3.04 7.81C3.02 8.1 3.26 8.34 3.54 8.34H20.46C20.75 8.34 20.99 8.09 20.96 7.81C20.76 5.42 19.45 3.81 16.75 3.56Z",fill:c}),
      React.createElement("path", {d:"M20 9.84H4C3.45 9.84 3 10.29 3 10.84V17C3 20 4.5 22 8 22H16C19.5 22 21 20 21 17V10.84C21 10.29 20.55 9.84 20 9.84Z",fill:c})
    );
  }
  return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
    React.createElement("path", {d:"M8 2V5",stroke:c,strokeWidth:"1.5",strokeMiterlimit:"10",strokeLinecap:"round",strokeLinejoin:"round"}),
    React.createElement("path", {d:"M16 2V5",stroke:c,strokeWidth:"1.5",strokeMiterlimit:"10",strokeLinecap:"round",strokeLinejoin:"round"}),
    React.createElement("path", {d:"M3.5 9.09H20.5",stroke:c,strokeWidth:"1.5",strokeMiterlimit:"10",strokeLinecap:"round",strokeLinejoin:"round"}),
    React.createElement("path", {d:"M21 8.5V17C21 20 19.5 22 16 22H8C4.5 22 3 20 3 17V8.5C3 5.5 4.5 3.5 8 3.5H16C19.5 3.5 21 5.5 21 8.5Z",stroke:c,strokeWidth:"1.5",strokeMiterlimit:"10",strokeLinecap:"round",strokeLinejoin:"round"})
  );
}

export function SendIcon({ color }) {
  var c = color || "#171717";
  return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
    React.createElement("path", {d:"M16.14 2.96L7.11 5.96C1.04 7.99 1.04 11.3 7.11 13.32L9.79 14.21L10.68 16.89C12.7 22.96 16.02 22.96 18.04 16.89L21.05 7.87C22.39 3.82 20.19 1.61 16.14 2.96Z",fill:c}),
    React.createElement("path", {d:"M16.46 8.34L12.66 12.16C12.51 12.31 12.32 12.38 12.13 12.38C11.94 12.38 11.75 12.31 11.6 12.16C11.31 11.87 11.31 11.39 11.6 11.1L15.4 7.28C15.69 6.99 16.17 6.99 16.46 7.28C16.75 7.57 16.75 8.05 16.46 8.34Z",fill:c})
  );
}

export function ThumbsUpIcon({ color }) {
  var c = color || "#171717";
  return React.createElement("svg", {width:"20",height:"20",viewBox:"0 0 35 35",fill:"none"},
    React.createElement("path", {d:"M9.72 33.5V15.9M1.5 21.02V28.38C1.5 30.17 1.5 31.07 1.86 31.75C2.17 32.35 2.68 32.84 3.3 33.15C4 33.5 4.92 33.5 6.76 33.5H24.33C26.73 33.5 27.94 33.5 28.91 33.07C29.76 32.7 30.49 32.09 31 31.32C31.58 30.45 31.77 29.3 32.13 26.99L32.99 21.55C33.47 18.5 33.72 16.98 33.25 15.79C32.84 14.75 32.07 13.88 31.08 13.33C29.95 12.7 28.36 12.7 25.19 12.7H23.87C22.95 12.7 22.48 12.7 22.13 12.53C21.82 12.37 21.57 12.13 21.41 11.83C21.23 11.48 21.23 11.04 21.23 10.14V5.45C21.23 3.27 19.42 1.5 17.18 1.5C16.65 1.5 16.16 1.81 15.94 2.28L10.42 14.38C10.17 14.93 10.04 15.21 9.84 15.41C9.67 15.59 9.45 15.72 9.21 15.81C8.94 15.9 8.63 15.9 8.01 15.9H6.76C4.92 15.9 4 15.9 3.3 16.25C2.68 16.56 2.17 17.05 1.86 17.65C1.5 18.33 1.5 19.23 1.5 21.02Z",stroke:c,strokeWidth:"2.5",strokeLinecap:"round",strokeLinejoin:"round"})
  );
}

export function MapIcon({ bold, color }) {
  var c = color || "#171717";
  if (bold) {
    return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
      React.createElement("path", {d:"M12 2C8.13 2 5 5.13 5 9C5 13.17 9.42 18.92 11.24 21.11C11.64 21.59 12.37 21.59 12.77 21.11C14.58 18.92 19 13.17 19 9C19 5.13 15.87 2 12 2ZM12 11.5C10.62 11.5 9.5 10.38 9.5 9C9.5 7.62 10.62 6.5 12 6.5C13.38 6.5 14.5 7.62 14.5 9C14.5 10.38 13.38 11.5 12 11.5Z",fill:c})
    );
  }
  return React.createElement("svg", {width:"24",height:"24",viewBox:"0 0 24 24",fill:"none"},
    React.createElement("path", {d:"M12 13.43C13.7231 13.43 15.12 12.0331 15.12 10.31C15.12 8.58687 13.7231 7.19 12 7.19C10.2769 7.19 8.88 8.58687 8.88 10.31C8.88 12.0331 10.2769 13.43 12 13.43Z",stroke:c,strokeWidth:"1.5"}),
    React.createElement("path", {d:"M3.62 8.49C5.59 -0.169998 18.42 -0.159998 20.38 8.5C21.53 13.58 18.37 17.88 15.6 20.54C13.59 22.48 10.41 22.48 8.39 20.54C5.63 17.88 2.47 13.57 3.62 8.49Z",stroke:c,strokeWidth:"1.5"})
  );
}
