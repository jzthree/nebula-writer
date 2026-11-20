# Nature Methods: published Methods paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

During inference, we found that it was necessary to apply normalization to the H&E images for both nuclei segmentation (Hover-Net) and single-cell gene expression prediction (GHIST). We found that the stain color affected the number of nuclei that Hover-Net predicted. The torchstain package (version 1.3.0)[58] was used to apply the Macenko normalization method[59] to each H&E patch. The reference was an unnormalized patch from a TCGA-BRCA H&E WSI for which Hover-Net performed well visually. Macenko stain normalization was also applied to the original TCGA H&E patches when input to GHIST. Here, the reference image was the whole H&E image from Xenium, downsampled such that 1 pixel = 10 μm.

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.

## Example 2

A densely packed volume of 56 µm × 56 µm × 35 µm was selected and cropped from the epidermis region of dataset 1—melanoma in situ for cell interaction analysis and 3D segmentation. From each cell, we measured the cell centroid and the distance to the nearest unobstructed neighboring cell edge/membrane to identify neighbors. We further used a minimum distance cut-off of 2 µm to identify neighbors that involved membrane contact. The number of missing neighbors in all virtual sections was normalized to the number of neighbors in the full tissue thickness, which was taken as ground truth ((number of neighboring cells in 2D)/(number of neighboring cells in 3D)).

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.

## Example 3

We used scooby to predict gene expression and accessibility profiles for both the original and motif-deleted sequences in each cell. For gene expression, we summed the predicted RNA-seq coverage over all exons within a gene. For accessibility, we summed the predicted scores across the entire 6,144 × 32-bp output bins. We averaged over the ten distinct random replacements. The prediction for each cell was divided by the size factor of its corresponding reference prediction and scaled by its median reference size factor. For each cell, we calculated the mean log2-fold change between the reference and alternative sequence predictions across differentially expressed genes, yielding a single TF score per cell.

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.

## Example 4

Our initial attempts to manually filter envelope lists revealed that defined cut-offs applied to simple scoring measures such as the fit score, signal-to-noise ratio or interference score were ineffective due to the extensive overlap between real and artifactual envelopes (Extended Data Fig. 3). Consequently, precisION incorporates a supervised machine learning algorithm for isotopic envelope classification, designed to uncover patterns in these complex data. Unlike previous machine learning-based approaches for envelope classification[37], which optimized the F1 score (the harmonic mean of the precision and recall) and aimed to create generalizable models, we focused on minimizing the false negative rate and developed a pipeline to create spectrum-specific classifiers.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.
