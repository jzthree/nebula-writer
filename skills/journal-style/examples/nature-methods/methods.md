# Nature Methods: published Methods paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

The backbone is parameterized by a set of learnable parameters θ of a deep learning segmentation model. The backbone predicts the probability of cell-type classes and background at each pixel. In this way, the model learns the relationships between pixels with morphology and cell type. We used the popular UNet 3+[60] (without the deep supervision component) as the backbone of our framework to perform nuclei segmentation and classification. This backbone architecture may be swapped out for other segmentation architectures. The architecture comprised an encoding branch and decoding branch with five levels of feature scales, and incorporated full-scale skip connections that combined low-level details with high-level features across different scales (resolutions).

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.

## Example 2

We used the SnapATAC-processed coverage AnnData directly during training and created coverage tracks per cell on the fly. Following the procedure described for Borzoi[8], we first aggregated the coverage and insertions in a 32-bp window. For RNA profiles, we followed the same squashed-scale approach as Borzoi, but set clip_soft to 5, such that the fraction of soft-clipped values at the single-cell level was similar to the one of Borzoi’s tracks. For ATAC profiles, we scaled the output by 0.05 to ensure they were on the same scale as the RNA coverage tracks. For faster evaluation on pseudobulks, we exported read aggregates per cell type to the bigWig format using sp.ex.export_coverage.

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.

## Example 3

Example single-cell image crops can be retrieved from any of the screens using a retrieval script included in our paper repository at https://github.com/broadinstitute/2022_PERISCOPE. Images are retrievable by gene name or sgRNA barcode sequence and example images can be chosen randomly or set to the most representative cells for that barcode as determined by closest k-means clustering using scikit-learn[87]. Individual channel crops are from corrected images on which the final analysis measurements are made. Mask crops are from segmentations generated during the analysis pipeline and are filled light gray to show the cell of interest and dark gray to show cells within the same crop assigned to the same perturbation.

Source: "A genome-wide atlas of human cell morphology", Nature Methods (2025), PMC11903339, CC BY 4.0.

## Example 4

A densely packed volume of 56 µm × 56 µm × 35 µm was selected and cropped from the epidermis region of dataset 1—melanoma in situ for cell interaction analysis and 3D segmentation. From each cell, we measured the cell centroid and the distance to the nearest unobstructed neighboring cell edge/membrane to identify neighbors. We further used a minimum distance cut-off of 2 µm to identify neighbors that involved membrane contact. The number of missing neighbors in all virtual sections was normalized to the number of neighbors in the full tissue thickness, which was taken as ground truth ((number of neighboring cells in 2D)/(number of neighboring cells in 3D)).

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.

## Example 5

We extracted the spike trains using the neo package in Python (http://neuralensemble.org/neo/) and converted them into rates using a Gaussian kernel with a s.d. of 100 ms. We subsampled the rates at 20-ms intervals using the elephant package[64] to match the sampling frequency in the decoded kinematics in ref. [30]. Finally, we used PCA to reduce the dimension from 24-channels to five. In Supplementary Fig. 4, we analyze the sensitivity to preprocessing hyperparameters, showing that our results remain stable for a broad range of Gaussian kernel scales. We also note that decoding accuracy marginally increased for seven and ten principal components at the cost of slower training time.

Source: "MARBLE: interpretable representations of neural population dynamics using geometric deep learning", Nature Methods (2025), PMC11903309, CC BY 4.0.

## Example 6

The ASCT+B tables in the sixth HRA release feature ontology-aligned terminology for 4,499 unique anatomical structures and 1,195 cell types. For some of these anatomical structures and cell types there exist anatomically aligned, spatially explicit reference objects. Specifically, there are 2D illustrations of 22 FTUs in 10 organs with 3,742 cells of 116 cell types plus 3D reference objects for 1,192 anatomical structures with 516 unique Uberon IDs in 65 3D reference objects (male and female, left and right organs) with 37 unique Uberon IDs. A crosswalk associates each of the 2D/3D anatomical structures and cell types with their corresponding terms in the ASCT+B tables (see SOP section)[96].

Source: "Human BioMolecular Atlas Program (HuBMAP): 3D Human Reference Atlas construction and usage", Nature Methods (2025), PMC11978508, CC BY 4.0.

## Example 7

Second, the deblurring and fusion module is designed for incoherent aperture synthesis and high-fidelity 3D reconstruction. The angular volumes are rearranged into a 4D tensor, where the angle information is packed into the channel dimension. The module comprises nine 3D convolutional layers and three linear interpolation layers, containing most of SeReNet’s network parameters. This design enables more-uniform spatial resolution and better axial performance (Supplementary Figs. 8 and 9). Detailed network parameters are provided in Supplementary Fig. 2 and Supplementary Table 1. By enabling rich interaction and fusion of angular features, the module effectively captures physical correlations and progressively converges to a 3D estimation. The deblurring and fusion module can be formularized as:

Source: "Physics-driven self-supervised learning for fast high-resolution robust 3D reconstruction of light-field microscopy", Nature Methods (2025), PMC12240845, CC BY 4.0.

## Example 8

To produce Supplementary Fig. 29, we applied the ProBound algorithm[33]. ProBound can predict the binding affinity for most TFs to a user-supplied DNA sequence. We used the refdata-cellranger-arc-mm10-2020-A-2.0.0 genome as a reference. To obtain putative promoter sequences for each gene in the reference, we extracted the DNA sequence 450 bp upstream and 149 bp downstream of the transcription start site of each gene. For each TF, we then ranked genes based on the predicted ProBound binding affinity to its putative transcription start site. We then used the top ten and bottom ten binding targets of each TF to produce the results illustrated in Supplementary Fig. 29.

Source: "Cell2fate infers RNA velocity modules to improve cell fate prediction", Nature Methods (2025), PMC11978503, CC BY 4.0.

## Example 9

To associate synapses with vertices on the skeleton, we get the supervoxel ID of the bound spatial point(s) associated with the annotation and use the ChunkedGraph to look up its associated L2 ID(s). We then assign synapses to graph vertices via L2 ID and use the invalidation mapping to associate graph vertices with supervoxel vertices. Similarly, L2 properties, such as volume or surface area for regions of a skeleton, can be computed by summing the appropriate values from the L2-Cache via the associated graph vertices. The core skeletonization process was implemented in MeshParty, and the interaction with the ChunkedGraph is handled through the Python library ‘pcg_skel’.

Source: "CAVE: Connectome Annotation Versioning Engine", Nature Methods (2025), PMC12074985, CC BY 4.0.

## Example 10

Our initial attempts to manually filter envelope lists revealed that defined cut-offs applied to simple scoring measures such as the fit score, signal-to-noise ratio or interference score were ineffective due to the extensive overlap between real and artifactual envelopes (Extended Data Fig. 3). Consequently, precisION incorporates a supervised machine learning algorithm for isotopic envelope classification, designed to uncover patterns in these complex data. Unlike previous machine learning-based approaches for envelope classification[37], which optimized the F1 score (the harmonic mean of the precision and recall) and aimed to create generalizable models, we focused on minimizing the false negative rate and developed a pipeline to create spectrum-specific classifiers.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.

## Example 11

A home-built epifluorescence microscope was used to compare the sCMOS (Hamamatsu Fusion BT), EMCCD (Andor iXon 897) and QIS (Gigajot QIS16TS) cameras. A schematic is shown in Supplementary Fig. 1a. A 40× oil-immersion objective lens (UPLXAPO40XO, Olympus) and the tube lens of the LV200 microscope (Olympus) constitute the main body of the epifluorescence microscope. A supercontinuum white-light fiber laser (SuperK FIU-15, NKT Photonics) was used as the excitation source for fluorescence experiments. The SuperK VARIA filter system was used to select the center wavelength and bandwidth. The filtered light was sent to the microscope setup through the FD1 PM fiber and collimated (AC254–030-A-ML, Thorlabs).

Source: "A telescopic microscope equipped with a quanta image sensor for live-cell bioluminescence imaging", Nature Methods (2025), PMC12165864, CC BY 4.0.

## Example 12

In reality, the set of genomic bins affected by LOH is unknown a priori. We predict genomic bins that are likely to be affected by LOH in the tumor by running step 1 through step 3 of CalicoST (Supplementary Fig. 14) assuming that each spot contains a single clone (Supplementary Text 2) with only BAF values. This results in a clustering of genomic bins according to the estimated BAF values. We infer LOH regions as the clusters for which the estimated BAF differs from the value of 0.5 expected for balanced regions by a user-defined threshold (default value = 0.2).

Source: "Inferring allele-specific copy number aberrations and tumor phylogeography from spatially resolved transcriptomics", Nature Methods (2024), PMC11621028, CC BY 4.0.
