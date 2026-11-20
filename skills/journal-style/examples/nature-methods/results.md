# Nature Methods: published Results paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

We applied CalicoST to infer allele-specific copy numbers on 10x Genomics Visium Spatial Transcriptomics data from 12 patients (26 slices) in HTAN (WashU cohort)[30] across three cancer types (‘Running CalicoST on SRT data’). For 11 of these patients, WES data from adjacent bulk tumor sections were also available, and we derived allele-specific integer copy numbers for 9 of these patients with sufficient tumor purity using HATCHet2 (ref. [34]; Supplementary Text 11). We used these copy numbers as the ground truth to benchmark the inferred CNAs from SRT data by CalicoST. We estimated the tumor purity per spot using allele frequency signals in LOH regions predicted by CalicoST (‘Inferring tumor proportions using BAF’) and explicitly modeled the inferred tumor proportions in CNA inference (Supplementary Text 3).

Source: "Inferring allele-specific copy number aberrations and tumor phylogeography from spatially resolved transcriptomics", Nature Methods (2024), PMC11621028, CC BY 4.0.

## Example 2

Cell2fate is a fully Bayesian model that is fit to raw cell-level counts as input, and it includes a series of refinements to account for technical sources of variation, including overdispersion, variation in detection sensitivity of spliced and unspliced RNA molecules, ambient RNA and known batches (Methods). A hierarchical prior structure achieves efficient regularization of model parameters while sharing evidence strength across genes (Methods). The model is implemented in the probabilistic programming language Pyro[14] and fit using Pyro’s stochastic variational inference framework using a customized variational distribution structure to account for dependencies between model parameters (Methods). The software implementation comes with guidelines and heuristics to determine hyperparameters such as the number of modules (Methods), and it builds on scvi-tools[15] to facilitate its integration in existing workflows.

Source: "Cell2fate infers RNA velocity modules to improve cell fate prediction", Nature Methods (2025), PMC11978503, CC BY 4.0.

## Example 3

The QIScope enables a range of live-cell bioluminescence studies that were previously not possible on the LV200/EMCCD system. We show here an additional feature of the QIScope missing from the conventional system: integration of epifluorescence. The LV200 system integrates fluorescence with bioluminescence imaging using transmission excitation, rather than epifluorescence[59]. This approach maximizes the FOV by keeping the microscope objective lens as close to the tube lens as possible, but at the cost of much higher background from excitation light bleed-through[25,26]. However, in the case of the QIScope, the telescope between the objective lens and tube lens creates ample room for a beamsplitter without sacrificing FOV (Fig. 2d). The integration of epifluorescence enables high-SNR multimodal measurements of, for example, two specific targets using orthogonal labels.

Source: "A telescopic microscope equipped with a quanta image sensor for live-cell bioluminescence imaging", Nature Methods (2025), PMC12165864, CC BY 4.0.

## Example 4

Following identification of the m/z-selected protein complex/es, precisION assigns ions through a hierarchical scheme based on our empirical understanding of native protein fragmentation and the biology of proteoform maturation (Fig. 1b). Initially, the algorithm assigns ions that are most likely to be observed and removes them from the fragment list before assigning those with lower probabilities. Throughout this annotation process, assigned ions serve as internal calibrants, minimizing mass errors and allowing for tight mass tolerances in successive assignment steps (Supplementary Fig. 3). Furthermore, to ensure robust fragment assignment, poorly fitting fragment matches are visually inspected by the user before assignment. This approach ensures exhaustive and accurate assignment of native top-down mass spectra, given an ample understanding of ion chemistry and the underlying protein biology.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.

## Example 5

To assess robustness of the single-cell decoder to slightly different cell states, we evaluated a model where all normoblast cells, constituting the terminal cell type of the erythroid lineage, were withheld both during construction of the single-cell embedding and training of scooby (Methods). Remarkably, using normoblast embeddings that were projected into the learned embedding after training yielded predictions with an accuracy close to the model trained on the full dataset (0.79 Pearson R compared to 0.81 for the model trained with normoblasts). Moreover, the best predictions were obtained using the normoblast embeddings as input to the decoder, followed by using embeddings of closely related cell types, indicative of scooby learning meaningful representations in embedding space that can be used to interpolate between different cell states (Fig. 2f).

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.

## Example 6

Cell metabolism is influenced by a vast array of interactions between genes and environmental stimuli and, as such, in vitro genetic screens carried out in traditional cell culture media, which poorly recapitulate physiologic environments, may fail to capture metabolically relevant phenotypes. Recently, in contrast to typical laboratory culture medium DMEM, ‘physiologic media’ such as Plasmax[38] or HPLM[39] have been developed as tools to study the effects of genetic perturbations under environmental conditions designed to more accurately mimic in vivo human physiology and, in a recent study, HPLM was shown to dramatically alter the spectrum of gene essentiality in K562 cells[21]. Such studies demonstrate the usefulness of screening under physiologically relevant conditions, but have been limited to growth assays, preventing the systematic assessment of gene perturbation on high-dimensional cell phenotypes.

Source: "A genome-wide atlas of human cell morphology", Nature Methods (2025), PMC11903339, CC BY 4.0.

## Example 7

These requirements are met by the ChunkedGraph proofreading system, whose design was described previously[28,29]. Like previous proofreading systems[26,30,31], the ChunkedGraph stores the segmentation as a graph of atomic segments, called supervoxels (Fig. 2a,b). Connected components in this graph represent cells (Fig. 2c). The ChunkedGraph introduced a representation of the segmentation as a spatially chunked hierarchical graph of supervoxels (Fig. 2d), where root nodes are individual cell segments, and leaf nodes are supervoxels. To achieve high performance, the ChunkedGraph requires a database featuring low-latency random row reads such as BigTable[39], which can add substantial cost to its deployment. CAVE uses the ChunkedGraph as proofreading backend and hosts it as a cloud service for world-wide access. Here, we describe two advancements to the ChunkedGraph to make it viable for petascale datasets.

Source: "CAVE: Connectome Annotation Versioning Engine", Nature Methods (2025), PMC12074985, CC BY 4.0.

## Example 8

The Jupyter Notebook on GitHub[67] demonstrates how to read a previously published CODEX multiplexed imaging dataset of the human intestine[69], identify how cell types correspond to larger multicellular structures and support exploration of the relationships between these higher order cellular neighborhoods. By visualizing the data in tissue coordinates, we can observe potential layering or consistent FTU structures, such as the repeat structure of the intestinal crypt in the proximal jejunum in the small intestine (see Fig. 3b, left). Furthermore, we can quantify these relationships across different scales of cellular neighborhoods and represent them as a network graph (Fig. 3b, right) in which line thickness indicates the percentage of cells in the next level. Note that the tissue samples and the graph use the very same node color coding and naming.

Source: "Human BioMolecular Atlas Program (HuBMAP): 3D Human Reference Atlas construction and usage", Nature Methods (2025), PMC11978508, CC BY 4.0.

## Example 9

To explore tissue thickness as a variable, 5–50-µm-thick sections were cut from FFPE blocks, mounted on glass slides and subjected to dewaxing and antigen retrieval[16]. Alternatively, to enable multiplexed imaging of friable sections, they were mounted on coverslips, held in place with an ‘adhesive’ coating (Matrigel) or black polyethylene micro-meshes and then placed in 3D-printed carriers made from acrylonitrile butadiene styrene (Methods and Extended Data Fig. 1a–c). Reconstruction of confocal image stacks was performed using Imaris (RRID: SCR_007370) software followed by visualization of primary data slices and 3D surface renderings (Supplementary Note). The 3D segmentation was used to identify individual cells, generate uniform manifold approximation and projection embeddings and distinguish among major immune and tumor cell types[17] (Extended Data Fig. 1d).

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.

## Example 10

a Schematic of a low-rank RNN, taking as input two stimuli and producing a decision variable as the output. Arrow endings represent inhibitory and excitatory connections. b Example input pattern for one of the stimuli and corresponding output pattern. Red and gray-shaded bands show stimulated and unstimulated periods. c Mean-field dynamics (heatmap and stream plot) superimposed with a sampled trajectory (orange) during one trial. d Space of input weights in a trained RNN. Unlike in Fig. 3d, here the network generalizes, that is, gives the same weighting to each input. Colors obtained by k-means clustering indicate two subpopulations specialized in one or the other input. e Mean-field dynamics for the low-rank RNN with input weights in d.

Source: "MARBLE: interpretable representations of neural population dynamics using geometric deep learning", Nature Methods (2025), PMC11903309, CC BY 4.0.

## Example 11

C. elegans is another commonly used animal model, widely studied in developmental biology[36] and neuroscience[9]. To show SeReNet’s application in large-scale neural imaging, we observed the whole body of a young NeuroPAL[37] transgenic C. elegans worm (strain OH16230) with GCaMP6s indicators and multi-color neural identities. Each neuron was uniquely identified by its color and position (Fig. 3f and Supplementary Video 3). NeuroPAL localized fluorophore expression to cell nuclei, which were densely packed in 3D space and clearly identified by SeReNet with subcellular resolution. SeReNet also resolved four neurons in the ventral nerve cord, which are neatly and tightly packed in the midbody (Fig. 3g,h). The temporal traces of neurons showed enhanced SNR with our method (Fig. 3i).

Source: "Physics-driven self-supervised learning for fast high-resolution robust 3D reconstruction of light-field microscopy", Nature Methods (2025), PMC12240845, CC BY 4.0.

## Example 12

Moreover, we tested the translational potential of predicted SGE for downstream applications using selected individuals from the The Cancer Genome Atlas Breast Invasive Carcinoma (TCGA-BRCA) dataset. Here we converted the predicted SGE to pseudobulk gene expression for each patient, and built multivariate Cox regression models from the pseudobulk gene expression to predict survival using a threefold cross-validation with 100 repeats (Fig. 3f). The corresponding RNA-seq and a subset (RNA-Seq-STgene), comprising only genes present in the HER2ST dataset, were used as baselines for survival analysis. GHIST achieved the highest average C-index of 0.57, compared to 0.55 for RNA-Seq-STgene. Next, we binarized the risk model predictions of each patient and split them into high-risk and low-risk groups based on the median risk prediction, then constructed Kaplan–Meier survival curves (Fig. 3g). GHIST showed translational potential by demonstrating a significant difference in survival profiles between individuals from different risk categories (P = 0.017).

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.
