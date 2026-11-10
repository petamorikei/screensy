/**
 * esbuild bundles the CSS Modules (local-css) and gives each one an object of its class names
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

/**
 * The stylesheets of Mantine, which esbuild bundles into screensy.css
 */
declare module "*.css";
