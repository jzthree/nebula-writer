# Nature Methods: published Results paragraphs

Paragraphs from Nature Methods research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

Dehydration is a component of the paraffin embedding process known to change the volume of FFPE specimens[18]. We found that sections cut at 5 µm on a microtome expanded to ~9 µm following rehydration; similar proportional expansion was observed over a 5–35-µm-thicknesses range (slope ~1.5). Conversely, paraformaldehyde-fixed tissue sections in PBS cut with a vibratome shrank ~1.5-fold upon dehydration but expanded to its original thickness when rehydrated (Extended Data Fig. 1e–f). When tumor cell nuclear aspect ratios were quantified after rehydration, we did not observe any systematic bias along the imaging (rehydration) axis (Extended Data Fig. 1g,h). Thus, rehydrated sections are likely to be representative of native tissue in three dimensions, at least on a local scale, but sections processed for H&E imaging are ~1.5-fold thinner. Thicknesses reported in this paper are the hydrated thickness as measured during image acquisition; when necessary ‘cut@’ is used to describe FFPE sectioning thickness (as in ‘cut@5 µm’).

Source: "Highly multiplexed 3D profiling of cell states and immune niches in human tumors", Nature Methods (2025), PMC12510885, CC BY 4.0.

## Example 2

High-resolution native top-down mass spectra are first deconvolved using a modified Richardson–Lucy algorithm (Fig. 1b and Supplementary Fig. 1). Then, clusters of peaks (that is, isotopic envelopes) corresponding to protein fragments are identified with the widely used algorithms TopFD[34] and THRASH[35,36]. The outputs of these algorithms are compiled into a comprehensive list of protein fragments. Due to the presence of noise and interference in raw spectra, these lists often include artifactual isotopic envelopes that cannot be reliably distinguished from the surrounding signal. We observed that scoring measures used by most established algorithms often struggle to differentiate real and artifactual envelopes when fixed thresholds are applied (Extended Data Fig. 3 and Supplementary Fig. 2). precisION therefore filters lists of fragments using a machine learning-based supervised voting classifier trained on spectrum-specific putative isotopic envelopes. Unlike existing machine learning algorithms for envelope filtering[37,38], precisION’s classifier is specifically tuned to minimize the number of true envelopes that are incorrectly discarded.

Source: "Uncovering hidden protein modifications with native top-down mass spectrometry", Nature Methods (2025), PMC12510877, CC BY 4.0.

## Example 3

Moreover, we tested the translational potential of predicted SGE for downstream applications using selected individuals from the The Cancer Genome Atlas Breast Invasive Carcinoma (TCGA-BRCA) dataset. Here we converted the predicted SGE to pseudobulk gene expression for each patient, and built multivariate Cox regression models from the pseudobulk gene expression to predict survival using a threefold cross-validation with 100 repeats (Fig. 3f). The corresponding RNA-seq and a subset (RNA-Seq-STgene), comprising only genes present in the HER2ST dataset, were used as baselines for survival analysis. GHIST achieved the highest average C-index of 0.57, compared to 0.55 for RNA-Seq-STgene. Next, we binarized the risk model predictions of each patient and split them into high-risk and low-risk groups based on the median risk prediction, then constructed Kaplan–Meier survival curves (Fig. 3g). GHIST showed translational potential by demonstrating a significant difference in survival profiles between individuals from different risk categories (P = 0.017).

Source: "Spatial gene expression at single-cell resolution from histology using deep learning with GHIST", Nature Methods (2025), PMC12446070, CC BY 4.0.

## Example 4

To assess the contribution of dataset-specific fine-tuning, we tested a scooby variant without LoRA fine-tuning, but instead directly feeding Borzoi embeddings into the cell-specific decoder. This resulted in decreased prediction accuracy, particularly for relative expression between cell types (across cell types Pearson R = 0.501), highlighting the importance of fine-tuning all layers of the model to the dataset (Extended Data Fig. 5). Consistent with that observation, we found that simpler models which only had cell-state-specific decoders on top of Borzoi’s human RNA-seq predictions and on top of all Borzoi’s predicted human tracks also performed notably worse (Extended Data Fig. 5). Furthermore, we designed a comparable model on pseudobulked profiles, which are predicted in a multi-task fashion while keeping the rest of the architecture the same. Still, scooby performed on par or slightly better on both cell-type-level metrics, showing that the scooby architecture does not trade cellular resolution for performance.

Source: "scooby: modeling multimodal genomic profiles from DNA sequence at single-cell resolution", Nature Methods (2025), PMC12615262, CC BY 4.0.
