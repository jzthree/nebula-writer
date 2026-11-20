# Nature Methods: published Discussion paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

In addition, existing workflows for mapping new experimental data to the HRA will be expanded in three main ways: (1) HuBMAP plans to add several new Azimuth references (for example, for large and small intestine) and update existing references (for example, for kidney and lung) to capture new data with additional/revised cell type annotations and CL terms plus CL IDs via crosswalks; (2) eight new OMAPs were published in the seventh HRA release and several more are in progress for the eighth HRA release, substantially increasing the number of spatial datasets that can be mapped to the HRA; and (3) starting with the eighth HRA release, new 3D organs will be added to the RUI: quadriceps femoris and triceps surae skeletal muscles, esophagus and lymphatic vasculature.

Source: "Human BioMolecular Atlas Program (HuBMAP): 3D Human Reference Atlas construction and usage", Nature Methods (2025), PMC11978508, CC BY 4.0.

## Example 2

Despite the speed up provided by proofreading of automated segmentations over manual tracing, the manual proofreading component of the reconstruction pipeline remains one of the costliest and slowest steps in the dataset creation process. Further advancements in automated reconstruction will be needed to enable scaling to larger datasets[57]. Instead of improving the automated segmentation directly, tools to automate the proofreading process are emerging[48,58]. Their application will require new workflows of human–artifical intelligence interaction[47]. Here, CAVE’s services have already served as a backend system to ingest edits from one such automated proofreading pipeline[48]. Due to its broad use, CAVE systems are already holding on to a wealth of data, both annotations and edit histories, that should be leveraged by automated methods to predict rich annotations of the data and help reduce the need for manual proofreading.

Source: "CAVE: Connectome Annotation Versioning Engine", Nature Methods (2025), PMC12074985, CC BY 4.0.

## Example 3

Although GHIST demonstrated strong discriminative performance when trained on a limited dataset, the restricted amount of data remains a limitation of the current study. During training, the model used thousands of high-resolution patches from a slide containing about 80,000 cells, which allowed the model to capture intricate details and subtle variations, thus ensuring strong practical performance even when trained on very limited samples. While the number of slides was limited, we were effectively learning from a larger number of matched cells from H&E images and gene expression measurements. This contributes to the model’s ability to generalize across H&E images from different cohorts, leading to robust and reliable predictions in real-world applications. We anticipate an increase in model robustness with the availability of more training data.

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.

## Example 4

The thick-section approach described probably represents an optimum for analysis of cells and local communities because it strikes a good balance between resolution, number of possible markers and sparing of tissue (an important consideration with clinical samples). However, a description of mammalian tissues must account for an ~10^6 range of length scales from intracellular organelles to entire organs; ultimately, this will require integrating methods including super resolution optical microscopy, light-sheet fluorescence microscopy[60,61], microscale computed tomography[20] and 3D transcript profiling. Across this continuum, as length scales increase, achievable resolution usually falls, as does the number of simultaneously addressable markers, but visualization of vessels, nerves and other extended structures greatly improves (Supplementary Note). Thus, the current work is best understood as an approach to the first part of the 3D continuum involving high-resolution imaging of cells, organelles and local neighborhoods.

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.

## Example 5

In this paper, we introduce SeReNet, a physics-driven self-supervised network for 3D reconstruction of LFM and its variants. SeReNet features a 700-fold increase in processing speed, more uniform resolution, and better sectioning ability compared with iterative tomography. It also has a twofold resolution enhancement, better generalization and greater robustness to noise, sample motion and aberrations compared with previous supervised networks. The ultrahigh processing throughput of SeReNet enables day-long recordings of up to 345,600 volumes, allowing for thorough analysis of sophisticated subcellular dynamics across multiple species. Its broad generalization capability ensures that pretrained SeReNet can be stably and robustly applied to data from the same sLFM system without requiring further parameter tuning. We have also demonstrated the effectiveness of SeReNet on different configurations of the system, including magnification, numerical aperture, angular resolution and scanning number (Supplementary Figs. 10 and 23).

Source: "Physics-driven self-supervised learning for fast high-resolution robust 3D reconstruction of light-field microscopy", Nature Methods (2025), PMC12240845, CC BY 4.0.

## Example 6

The ability of precisION to derive biological insights depends critically on the quality of input spectra. While high-quality nTDMS data can now be routinely obtained using commercial instrumentation, it remains critical to optimize spectral quality during acquisition. Instruments with low-resolution mass analyzers or limited fragmentation capabilities are less likely to yield the same depth of insight into proteoform diversity, primarily due to the reduced interpretability of the resulting data. Furthermore, precisION’s current methodologies are not yet fully compatible with systems where fragmentation is confined to a small number of specific sites; in our and others’ experience, directed cleavage occurs when there are no mobile charge carriers available on the precursor ions[68–70]. In such cases, experimental adjustments are necessary to confidently identify relevant fragment ions. These adjustments may include enhancing fragmentation through ion supercharging or employing multistage tandem MS techniques.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.

## Example 7

We chose to mainly evaluate scooby on a 10x multiome hematopoiesis dataset, as it provides both paired scATAC-seq and scRNA-seq profiles for joint modeling and well-characterized differentiation lineages for validating TF motif effects and target gene predictions, making it an ideal test bed for our study. As scooby predicts RNA-seq coverage, it could in principle be used to predict differential isoform usage; however, the 10x scRNA-seq 3’ coverage bias limits the signal for splice sites and TSS choice[15]. Furthermore, we observed little evidence for differential isoform usage in the dataset, concordant with studies finding that alternative transcript usage is most pronounced in brain and muscle tissues[48]. Thus, future work applying scooby to more diverse cell types or applications to alternative single-cell protocols such as SMART-seq[49] or long-read sequencing[50] is needed to assess the potential of scooby to model isoform-specific expression.

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.

## Example 8

In addition to being practical, PERISCOPE generates rich, data-driven representations of gene function. A central goal of massively parallel genetic screens is to understand how genes coordinate to produce complex cell phenotypes and, in this regard, PERISCOPE is valuable both as a profiling technology—generating high-dimensional representations of a cell state—and as highly parallelized screens of subcellular biological parameters (for example, cell size and organelle size, shape and number). We showcase the ability to reconstruct relationships between genes in biological pathways and proteins in complexes using whole-cell optical profiles. Furthermore, we demonstrate the potential to gain mechanistic insights into gene function through spatially restricted subcellular phenotypes (TMEM251) and the classification of genes by function (V-ATPase assembly) using individual morphological features.

Source: "A genome-wide atlas of human cell morphology", Nature Methods (2025), PMC11903339, CC BY 4.0.

## Example 9

Despite cell2fate’s improved biophysical accuracy, the model still makes simplifying assumptions, such as a constant degradation rate and no stochastic bifurcations. However, the concepts proposed in cell2fate are general and give rise to several extensions that can further increase the biophysical accuracy of the model in the future without resorting to numerical approximations. This includes RNA velocity models with cell-specific splicing and degradation rates, stochastic rates at lineage-branching points and causal connections between transcription rates at different time points, equivalent to dynamic gene regulatory networks (Supplementary Notes). In the long term, dynamical models should also include the effects of cell–cell interactions, based on signaling molecules measured with spatial transcriptomics. An immediate step toward this goal would be combining RNA velocity module mapping with spatial cell–cell interaction tools, such as NCEM[39], which could identify putative interactions that drive specific steps of a differentiation process.

Source: "Cell2fate infers RNA velocity modules to improve cell fate prediction", Nature Methods (2025), PMC11978503, CC BY 4.0.

## Example 10

A hallmark of large collective systems such as the brain is the existence of many system realizations that lead to equivalent computations defined by population-level dynamical processes[51,52]. The growing recognition that dynamics in biological and artificial neural networks evolve over low-dimensional manifolds[5,6,8,9] offers an opportunity to reconcile dynamical variability across system realizations with the observed invariance of computations by using manifold geometry as an inductive bias in learning dynamical representations. We have shown that nonlinear dynamical systems can be represented as a decomposition of LFFs that are jointly mapped into latent space. Due to the continuity of the dynamics over the manifold, this mapping can be learned using unsupervised geometric deep learning. Further, latent representations can be made robust to different embeddings of the dynamics by making the extracted LFFs rotation-invariant. These properties enable comparing dynamics across animals and instances of artificial neural networks.

Source: "MARBLE: interpretable representations of neural population dynamics using geometric deep learning", Nature Methods (2025), PMC11903309, CC BY 4.0.

## Example 11

The full range of capabilities for the QIScope has not been realized. The SNR could theoretically be boosted simply with brighter luciferase substrates such as fluorofurimazine or hikarazine-003 (ref. [17]). These brighter substrates could then be used with different combinations of optics to obtain even greater spatial resolution (higher magnification) or greater SNR, depending on the application. The QIScope is currently optimized for blue-light detection, coinciding with the emission spectra of many bioluminescent reporters. However, wavelength multiplexing can be achieved with different enzyme–substrate pairs, along with spectral filter or phasor analysis[11,65]. The multi-modality of the QIScope can be readily expanded due to its open telescopic design. For instance, phase contrast or differential interference contrast imaging, previously not possible to integrate into conventional bioluminescence microscopes due to lack of space between the objective and tube lens, can now be incorporated. The telescopic setup also accommodates other small-sized detectors, such as single-photon avalanche diode arrays for time-of-flight imaging at the cellular level or next-generation QIS cameras, without sacrificing FOV.

Source: "A telescopic microscope equipped with a quanta image sensor for live-cell bioluminescence imaging", Nature Methods (2025), PMC12165864, CC BY 4.0.

## Example 12

We introduced CalicoST, an algorithm that infers allele-specific copy numbers and reconstructs a phylogeography relating cancer clones in time and space using SRT data. CalicoST uses inferred LOH events to construct a phylogeny relating the cancer clones and a phylogeography in space, integrating both genomic and spatial evolution of a tumor in a unified model. When multiple slices are available, CalicoST infers a joint phylogeography across the slices including 3D models of spatial tumor evolution.

Source: "Inferring allele-specific copy number aberrations and tumor phylogeography from spatially resolved transcriptomics", Nature Methods (2024), PMC11621028, CC BY 4.0.
