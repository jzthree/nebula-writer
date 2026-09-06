declare module "mathjax" {
  interface MathJaxRuntime {
    mathml2svgPromise(mathml: string, options: { display?: boolean }): Promise<unknown>;
    startup: {
      adaptor: {
        serializeXML(node: unknown): string;
      };
    };
  }

  const MathJax: {
    init(config: unknown): Promise<MathJaxRuntime>;
  };

  export default MathJax;
}
