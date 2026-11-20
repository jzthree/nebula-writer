# Nature Methods: published introduction paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

As a second part of CAVE, we addressed the challenge of supporting analysis of proofreadable cell segmentations in conjunction with annotations produced by automated methods and individual users. CAVE enables fast computation of morphological neuron features and representations at any time, including immediately after an edit, through an extension to the ChunkedGraph. We introduce a scheme for storing annotations, which binds annotations to segment IDs at specific points in time in a process we call ‘materialization’. We show that CAVE’s annotation and proofreading systems support fast queries of the data for any point in time by combining traditional database queries with ChunkedGraph-based tracking of neuron edit histories. This enables CAVE to answer analysis queries with no delays after an edit and queries of the dataset at arbitrary time points.

Source: "CAVE: Connectome Annotation Versioning Engine", Nature Methods (2025), PMC12074985, CC BY 4.0.

## Example 2

To overcome these limitations, we present scooby, which jointly models scATAC-seq and single-cell RNA-sequencing (scRNA-seq) genomic profiles from sequence without the need for annotations and easily scales to large datasets. scooby builds upon Borzoi[8], a recently released bulk omics model that uses RNA-seq coverage as an annotation-free representation of gene regulation. Using Borzoi as a foundation model, we equip it with a cell-specific decoder, and fine-tune its sequence embeddings to adapt it to the single-cell setting. We call this adapted model ‘scooby’, a nod to both its single-cell focus and its canine-named model ancestry. We demonstrate scooby’s capabilities to accurately model genomic profiles at single-cell resolution, identify lineage-specific regulators and their putative target genes, and delineate cell-type-specific variant effects on a multiome hematopoiesis dataset, benchmarking it against state-of-the-art models.

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.

## Example 3

The main limitation of bioluminescence remains its low emission intensity. Despite advancements in proteins and substrates[8,14–17], enzymatic turnover inevitably restricts bioluminescence photon emission to rates orders of magnitude lower than possible by photon absorption and emission in fluorophores[10,18,19]. Therefore, bioluminescence imaging of cells generally requires specialized microscopes optimized for photon collection, transmission, image formation and detection, at the expense of spatial and temporal resolution, field of view (FOV) and dynamic range[20,21]. Unfortunately, in contrast to probes, advancements in bioluminescence microscopes have been relatively stagnant largely due to the constraints of the leading detector technology for low-light imaging: the electron-multiplying charge-coupled device (EMCCD)[22]. As a result, the advantages of bioluminescence often do not outweigh its disadvantages when researchers aim to resolve structures and dynamics at the subcellular level.

Source: "A telescopic microscope equipped with a quanta image sensor for live-cell bioluminescence imaging", Nature Methods (2025), PMC12165864, CC BY 4.0.

## Example 4

Equipped with SeReNet, sLFM facilitates versatile high-speed subcellular 3D observations in vivo with day-long durations in diverse animals including zebrafish (Danio rerio) embryos, Dictyostelium discoideum, Caenorhabditis elegans, zebrafish larvae and mice. Processing the massive tens of terabytes of data, with more than 300,000 volumes, produced from imaging these animals would take several years for previous iterative algorithms with high fidelity; however, SeReNet requires only 5 days, with even better axial performance. These advantages have allowed us to perform long-term monitoring of diverse subcellular dynamics during multiple liver injuries and conduct large-scale day-long cell tracking of immune responses. We believe that, with its broad generalization, low computational costs and high fidelity, SeReNet will lead to widespread practical applications of LFM and its variants in diverse fields such as neuroscience, immunology and pathology.

Source: "Physics-driven self-supervised learning for fast high-resolution robust 3D reconstruction of light-field microscopy", Nature Methods (2025), PMC12240845, CC BY 4.0.

## Example 5

Recent advances in instrumentation[13,16,20–22] have propelled nTDMS toward the study of proteoform-specific interactions in complex cellular and tissue environments[9,19,23–25]. However, these intricate systems present unique challenges that complicate accurate, informative and reproducible interpretation of mass spectral data, hindering discovery of new biology and definitive characterization of proteoforms[26]. In particular, despite ongoing efforts to streamline sample preparation, and ensure high-quality spectra[27–30], many biomolecular complexes are inherently heterogeneous, preventing unambiguous determination of individual subunit masses and consequent detection of protein modifications at the intact protein level[31,32]. While reducing heterogeneity through (bio)chemical methods (for example, delipidation, deglycosylation or in-solution disassembly) is appealing, such approaches may disrupt complexes, and ultimately contradict the goal of complete molecular characterization. Instead, embracing the complexity of these systems is essential, and the challenge lies in extracting meaningful information from these inherently complex nTDMS spectra.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.

## Example 6

It is increasingly recognized that the dynamics of neural populations underpin computations in the brain and in artificial neural networks[1–3] and that these dynamics often take place on low-dimensional smooth subspaces, called neural manifolds[4–12]. From this perspective, several works have focused on how the geometry[4,7,13,14] or topology[6,8,9] of neural manifolds relates to the underlying task or computation. By contrast, others have suggested that dynamical flows of neural population activity play an equally prominent role[11,15–17] and that the geometry of the manifold is merely the result of embedding of a latent dynamical activity into neural space that changes over time or across individuals[4,18]. Although recent experimental techniques provide a means to simultaneously record the activity of large neuron populations[19–21], inferring the underpinning latent dynamical processes from data and interpreting their relevance in computational tasks remains a fundamental challenge[16].

Source: "MARBLE: interpretable representations of neural population dynamics using geometric deep learning", Nature Methods (2025), PMC11903309, CC BY 4.0.

## Example 7

Recent technological advances in spatial sequencing provide a promising direction for studies of spatiotemporal tumor evolution. While high-quality spatial DNA sequencing would provide the ideal dataset for spatiotemporal evolution studies, such technologies remain in active development[10] and are not yet widely applied. However, SRT technologies that measure RNA simultaneously from thousands of spatial locations in a tissue have found extensive applications in analyzing the spatial organization of transcriptionally defined cell types within a tumor[11–14]. Even though somatic mutations occur in DNA and are not directly measured by SRT, large CNAs leave a signature in gene expression; namely, a deletion of a genomic region tends to result in underexpression of genes in the region, while an amplification tends to result in overexpression. Thus, identification of CNAs from transcriptomic data is a promising direction for analysis of somatic evolution in tumors.

Source: "Inferring allele-specific copy number aberrations and tumor phylogeography from spatially resolved transcriptomics", Nature Methods (2024), PMC11621028, CC BY 4.0.

## Example 8

When HuBMAP was launched, the first unifying concepts that map major organs in the human body across scales were emerging[4,5]. Existing atlases used organ-specific references (for example, Waxholm Space for the brain[6] or the Helmsley one-dimensional distance reference system for the colon), but most of these references do not map to a shared human body CCF[7]. To advance CCF development, in March 2020, the National Institutes of Health (NIH) and the Human Cell Atlas (HCA)[8] Consortium organized a joint virtual meeting with a CCF breakout session. This resulted in the formation of the HRA Working Group (WG). Over the last 55 months, WG members jointly developed a definition and key properties for the HRA. These properties are:

Source: "Human BioMolecular Atlas Program (HuBMAP): 3D Human Reference Atlas construction and usage", Nature Methods (2025), PMC11978508, CC BY 4.0.

## Example 9

Spatially resolved transcriptomics (SRT) profiling technologies provide spatially resolved mapping of gene expression and hold the potential to revolutionize our understanding of multicellular biological systems. SRT can enable new insights to improve the prediction of key clinical outcomes of complex diseases, including cancers[1–4]. The recent subcellular in situ imaging-based SRT, herein referred to as subcellular spatial transcriptomics (SST), platforms (for example, 10x Xenium[5], NanoString CosMx[6] and Vizgen MERSCOPE) can map spatial gene expression (SGE) at subcellular resolution. Spot-based SRT platforms (for example, 10x Visium) typically capture the gene expression of multiple cells per spot, generating spot-based SGE. In contrast, the newer SST data are assayed at a resolution smaller than the typical cell and are typically passed through a cell segmentation workflow to provide ‘single-cell SGE’. This finer spatial resolution of gene expression unlocks the capacity to explore a variety of hypotheses that were previously inaccessible and provide deeper biological insights.

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.

## Example 10

The concept of ‘RNA velocity’, which involves inferring transcriptional dynamics from spliced and unspliced counts in single-cell RNA sequencing (scRNA-seq), has displayed notable potential[1–4]. The first implementations of RNA velocity models[1–3] have undergone an evolution of conceptual and technical refinements, including improved parameter inference[5–7] as well as the use of numerical approaches[6,8–10] to solve the underlying differential equations. However, these existing refinements are bound to tradeoffs between either introducing coarse biophysical approximations[1–3,5,7,11,12] or relying on extensive numerical approximations[6,8–10]. Hence, the fundamental challenge remains to define a mathematically sound framework that allows for capturing realistic transcriptional dynamics while retaining computational and numerical tractability.

Source: "Cell2fate infers RNA velocity modules to improve cell fate prediction", Nature Methods (2025), PMC11978503, CC BY 4.0.

## Example 11

Here, we combined unbiased high-dimensional image-based cell phenotyping with massively parallel optical pooled CRISPR screens to build the first genome-scale perturbation atlas of morphology phenotypes in human cells. We report the design of an optimized cell phenotyping panel based on the popular Cell Painting[19,20] image-based profiling assay that enables five-color fluorescence microscopy of cell phenotypes followed by four-color in situ sequencing by synthesis (ISS) to assign perturbations to cells. We also built a scalable, open-source, cloud-based pipeline for generating barcoded image-based profiles from genome-scale perturbation datasets. We use this technology to execute two whole-genome pooled optical CRISPR screens in human cervical cancer cells (HeLa) cultured either in traditional cell culture medium or physiologic medium[21], profiling the effects of >20,000 single gene knockouts (KOs) in unbiased fashion and mapping genome-wide gene-by-environment interactions. We additionally apply our approach in human lung cancer cells (A549). Together, this work establishes a valuable resource for connecting human genotypes to high-dimensional image-based cellular phenotypes at scale.

Source: "A genome-wide atlas of human cell morphology", Nature Methods (2025), PMC11903339, CC BY 4.0.

## Example 12

Rigorous assessment of cell morphology in research settings enables detailed analysis of processes such as organelle dynamics, cell migration and intracellular trafficking[1] and also plays a central role in the histopathological diagnosis of disease[2]. Rapid innovations in optical microscopy have enabled ever more precise three-dimensional (3D) characterization of cultured cells and model organisms[3]. Multiplexed tissue imaging (‘spatial proteomics’)[4] extends both histopathology and tissue biology by enabling the measurement of dozens of molecular markers in a preserved tissue environment. However, with a few noteworthy exceptions[5–7], most contemporary spatial proteomics is performed using widefield two-dimensional (2D) imaging methods at a resolution (commonly 0.6–2.0 µm laterally) that obscures fine morphological and intracellular details. The current emphasis on assay plex[8] and rapid data acquisition has merit, but the precise distribution of proteins within and outside of cells represents an invaluable source of information about cell types and states[9,10]. Opportunities therefore exist to marry high-resolution 3D microscopy with spatial proteomics, particularly of the formaldehyde fixed paraffin-embedded (FFPE) specimens universally used for human diagnosis[11] and analysis of murine models[12].

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.
