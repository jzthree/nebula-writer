declare module "mathjax" {
  export interface MathJaxRuntime {
    mathml2svgPromise(mathml: string, options: { display?: boolean }): Promise<unknown>;
    startup: {
      adaptor: {
        serializeXML(node: unknown): string;
      };
    };
  }

  const MathJax: {
    init(options: { loader: { load: string[] } }): Promise<MathJaxRuntime>;
  };

  export default MathJax;
}
